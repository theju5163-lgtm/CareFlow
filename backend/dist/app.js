// @ts-nocheck
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { Hospital, HospitalMembership, User, Patient, Department, Call, Task, Appointment, PatientMessage, Admission, Discharge, InsuranceCase, BillingRecord, MedicalRecord, DocumentChecklist, FollowUp, AuditLog } from './models.js';
import { can, roleMatchesAccountType, signAccessToken, validStatusTransition } from './security.js';
import { connectToCareFlowDatabase } from './config/database.js';
import { runInHospital, runWithoutHospital } from './tenant-context.js';
import { exotelConfiguration, initiateExotelCall, endExotelCall, getExotelCallStatus, mapExotelStatus, normalizeIndiaNumber, validExotelWebhookToken } from './services/exotel.js';
const app = express();
const jwtSecret = process.env.JWT_SECRET || '';
const accountRoles = ['admin', 'coordinator', 'staff', 'patient', 'doctor', 'nurse', 'receptionist', 'appointment_coordinator', 'admission_coordinator', 'discharge_coordinator', 'medical_records_officer', 'insurance_officer', 'billing_officer', 'patient_relations_officer', 'supervisor', 'auditor'];
const responsibleRoles = ['Appointment Staff', 'Patient Support Staff', 'Billing Staff', 'Clinical Review Staff', 'Administrator'];
const aiEnabled = process.env.AI_EXTERNAL_PROCESSING_ENABLED === 'true' && Boolean(process.env.OPENAI_API_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.disable('x-powered-by');
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
const fail = (res, status, error, detail) => res.status(status).json({ error, ...(detail ? { detail } : {}) });
const clean = value => typeof value === 'string' ? value.trim() : '';
const allowed = (req, res, permission) => { if (can(req.user.role, permission))
    return true; fail(res, 403, 'Insufficient role permissions.'); return false; };
const parseId = value => mongoose.isValidObjectId(value);
const isDemoMode = req => req.query.mode === 'demo';
const modeFilter = req => ({ isDemo: isDemoMode(req) });
const startOfDayInZone = (timeZone, at = new Date()) => {
    const format = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day), h = Number(parts.hour), min = Number(parts.minute), s = Number(parts.second);
    const localMidnightAsUtc = Date.UTC(y, m - 1, d);
    let guess = localMidnightAsUtc;
    for (let i = 0; i < 2; i++) {
        const localAtGuess = Object.fromEntries(format.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
        const represented = Date.UTC(Number(localAtGuess.year), Number(localAtGuess.month) - 1, Number(localAtGuess.day), Number(localAtGuess.hour), Number(localAtGuess.minute), Number(localAtGuess.second));
        const instant = Date.UTC(y, m - 1, d, h, min, s);
        const offset = represented - guess;
        guess = localMidnightAsUtc - offset;
    }
    return new Date(guess);
};
const staffSafePatient = (patient, role) => {
    if (!patient)
        return null;
    const object = typeof patient.toObject === 'function' ? patient.toObject() : { ...patient };
    delete object.phoneVerifiedBy;
    if (!['admin', 'coordinator'].includes(role)) {
        delete object.phone;
        delete object.email;
        delete object.consentToProcessing;
    }
    delete object.__v;
    return object;
};
const populateCall = query => query.populate('patientId', 'displayName externalId isDemo').populate('reviewedBy', 'name role').populate('assignedTo', 'name role').populate('proposedTasks.departmentId', 'name');
const audit = (actorId, action, recordType, recordId, details = {}) => AuditLog.create({ actorId, action, recordType, recordId: String(recordId || ''), details });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get('/api/health', (_req, res) => res.json({ status: mongoose.connection.readyState === 1 ? 'ok' : 'degraded', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', databaseName: 'careflow_ai', ai: aiEnabled ? 'configured' : 'disabled', speech: aiEnabled ? 'configured' : 'disabled', telephony: exotelConfiguration() ? 'configured' : 'disabled', telephonyProvider: 'Exotel', faceLogin: 'disabled', voiceLogin: 'disabled', timestamp: new Date().toISOString() }));
app.post('/api/webhooks/exotel/:token/:callId', asyncRoute(async (req, res) => {
    if (!validExotelWebhookToken(req.params.token))
        return fail(res, 401, 'Invalid provider callback token.');
    if (!parseId(req.params.callId))
        return fail(res, 400, 'Invalid callback call identifier.');
    const details = req.body?.Call || req.body?.call_details || req.body || {};
    const sid = clean(details.Sid || details.sid || req.body?.CallSid || req.body?.CallSID);
    const rawStatus = clean(details.Status || details.status || req.body?.Status);
    const event = clean(req.body?.event_details?.event_type || req.body?.EventType).toLowerCase();
    const next = mapExotelStatus(rawStatus || (event === 'answered' ? 'in-progress' : ''));
    if (!next)
        return res.status(204).end();
    const call = await runWithoutHospital(() => Call.findOne({ _id: req.params.callId, telephonyProvider: 'exotel' }));
    if (!call || (sid && call.providerCallId && call.providerCallId !== sid))
        return fail(res, 404, 'Call record for provider callback was not found.');
    await runInHospital(String(call.hospitalId), async () => {
        const terminalStates = ['Completed', 'Busy', 'No Answer', 'Failed'];
        const wasTerminal = terminalStates.includes(call.callState);
        const isTerminal = terminalStates.includes(next);
        call.providerCallId ||= sid;
        const recordingUrl = clean(details.RecordingUrl || details.recording_url);
        if (call.recordingConsentConfirmedAt && recordingUrl.startsWith('https://') && recordingUrl.length <= 2000)
            call.providerRecordingUrl = recordingUrl;
        if (!wasTerminal || isTerminal) {
            call.providerStatus = rawStatus || event;
            call.callState = next;
            if (next === 'In Progress' || next === 'Connected')
                call.connectedAt ||= new Date();
            const duration = Number(details.Duration ?? details.duration);
            if (Number.isFinite(duration) && duration >= 0)
                call.durationSeconds = duration;
        }
        if (!wasTerminal && isTerminal) {
            call.status = next === 'Completed' ? 'completed' : next === 'Failed' ? 'abandoned' : 'missed';
            call.endedAt = call.endedAt || new Date();
        }
        await call.save();
        await audit(call.createdBy, 'call.provider_status_updated', 'Call', call._id, { provider: 'exotel', status: next, event });
    });
    res.status(204).end();
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
    if (mongoose.connection.readyState !== 1)
        return fail(res, 503, 'Database is not connected. Start MongoDB and retry.');
    const email = clean(req.body?.email).toLowerCase();
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || password.length < 1 || password.length > 200)
        return fail(res, 400, 'Email and password are required.');
    const user = await User.findOne({ email, active: true }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
        return fail(res, 401, 'Email or password is incorrect.');
    const membershipRows = await HospitalMembership.find({ userId: user._id, active: true }).lean();
    const memberships = membershipRows.map(m => String(m.hospitalId));
    const hospitalId = clean(req.body?.hospitalId) || memberships[0] || '';
    if (!hospitalId || !memberships.includes(hospitalId))
        return fail(res, 403, 'This account has no access to the selected hospital.');
    const hospital = await Hospital.findById(hospitalId).select('name status currency timeZone');
    if (!hospital || hospital.status === 'suspended')
        return fail(res, 403, 'This hospital workspace is unavailable.');
    const selectedMembership = membershipRows.find(m => String(m.hospitalId) === hospitalId);
    const accountType = req.body?.accountType;
    if (accountType && !['patient', 'staff', 'admin'].includes(accountType))
        return fail(res, 400, 'Choose Patient, Staff, or Administrator.');
    if (accountType && !roleMatchesAccountType(selectedMembership.role, accountType))
        return fail(res, 403, 'This account does not have the selected account type in this hospital.');
    const token = signAccessToken({ _id: user._id, role: selectedMembership.role, email: user.email }, jwtSecret, process.env.JWT_EXPIRES_IN || '8h', hospitalId);
    await runInHospital(hospitalId, () => audit(user._id, 'auth.login', 'User', user._id, { role: user.role }));
    const hospitalRows = await Hospital.find({ _id: { $in: memberships } }).select('name status currency timeZone').lean();
    res.json({ token, hospitalId, hospitals: hospitalRows.map(h => ({ ...h, role: membershipRows.find(m => String(m.hospitalId) === String(h._id))?.role })), user: { id: user.id, name: user.name, email: user.email, role: selectedMembership.role, patientId: selectedMembership.patientId || null } });
}));
app.post('/api/auth/forgot-password', loginLimiter, (_req, res) => res.status(202).json({ message: 'Password recovery is not configured in this demonstration. Contact your CareFlow administrator.' }));
app.post('/api/hospitals/register', loginLimiter, asyncRoute(async (req, res) => {
    if (mongoose.connection.readyState !== 1)
        return fail(res, 503, 'Database is not connected. Start MongoDB and retry.');
    const name = clean(req.body?.name), email = clean(req.body?.adminEmail).toLowerCase(), adminName = clean(req.body?.adminName), password = req.body?.password;
    if (!name || name.length > 180 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !adminName || typeof password !== 'string' || password.length < 12 || password.length > 200)
        return fail(res, 400, 'Provide hospital details, administrator name/email, and a password with at least 12 characters.');
    if (await User.exists({ email }))
        return fail(res, 409, 'An account already exists for this email. Sign in or contact the administrator.');
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'hospital';
    const hospital = await Hospital.create({ name, slug: `${baseSlug}-${new mongoose.Types.ObjectId().toString().slice(-6)}`, address: clean(req.body?.address).slice(0, 500), city: clean(req.body?.city).slice(0, 100), state: clean(req.body?.state).slice(0, 100), phone: clean(req.body?.phone).slice(0, 40), email: clean(req.body?.contactEmail).slice(0, 160), currency: 'INR', timeZone: 'Asia/Kolkata', status: 'pending_verification' });
    const user = await User.create({ hospitalId: hospital._id, hospitalIds: [hospital._id], name: adminName, email, role: 'admin', passwordHash: await bcrypt.hash(password, 12), active: true });
    await HospitalMembership.create({ hospitalId: hospital._id, userId: user._id, role: 'admin', active: true });
    hospital.createdBy = user._id;
    await hospital.save();
    res.status(201).json({ message: 'Hospital workspace created and marked pending verification.', hospital: { id: hospital.id, name: hospital.name, status: hospital.status }, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));
app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/auth/login')
        return next();
    if (mongoose.connection.readyState !== 1)
        return fail(res, 503, 'Database is not connected. Start MongoDB and retry.');
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer '))
        return fail(res, 401, 'Sign in to continue.');
    try {
        const claims = jwt.verify(header.slice(7), jwtSecret, { issuer: 'careflow-ai' });
        req.auth = claims;
        next();
    }
    catch {
        return fail(res, 401, 'Session expired or invalid. Sign in again.');
    }
});
app.use('/api', asyncRoute(async (req, res, next) => {
    if (req.path === '/health' || req.path === '/auth/login')
        return next();
    const user = await User.findOne({ _id: req.auth.sub, active: true }).select('name email role departmentId patientId hospitalId hospitalIds');
    if (!user)
        return fail(res, 401, 'Account is inactive or unavailable.');
    const memberships = await HospitalMembership.find({ userId: user._id, active: true }).lean();
    const membershipIds = memberships.map(m => String(m.hospitalId));
    const hospitalId = clean(req.get('x-hospital-id')) || req.auth.hospitalId || String(memberships[0]?.hospitalId || '');
    if (!hospitalId || !membershipIds.includes(hospitalId))
        return fail(res, 403, 'You do not have access to this hospital workspace.');
    const membership = memberships.find(m => String(m.hospitalId) === hospitalId);
    const hospital = await Hospital.findById(hospitalId).select('name status currency timeZone');
    if (!hospital || hospital.status === 'suspended')
        return fail(res, 403, 'This hospital workspace is unavailable.');
    req.user = { ...user.toObject(), id: user.id, name: user.name, role: membership.role, patientId: membership.patientId || null, departmentId: membership.departmentId || null, hospitalId };
    req.hospital = hospital;
    runInHospital(hospitalId, next);
}));
app.get('/api/auth/me', asyncRoute(async (req, res) => {
    const membershipRows = await HospitalMembership.find({ userId: req.user._id, active: true }).lean();
    const ids = membershipRows.map(m => String(m.hospitalId));
    const hospitalRows = await Hospital.find({ _id: { $in: ids } }).select('name status currency timeZone').lean();
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, patientId: req.user.patientId || null }, hospital: req.hospital, hospitals: hospitalRows.map(h => ({ ...h, role: membershipRows.find(m => String(m.hospitalId) === String(h._id))?.role })) });
}));
app.get('/api/hospitals', asyncRoute(async (req, res) => {
    const rows = await HospitalMembership.find({ userId: req.user._id, active: true }).lean();
    res.json(await Hospital.find({ _id: { $in: rows.map(m => m.hospitalId) } }).select('name address city state status currency timeZone').sort({ name: 1 }).lean());
}));
app.patch('/api/hospitals/current', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'hospital:manage'))
        return;
    const { name, address, city, state, phone, email, currency, timeZone } = req.body || {};
    const hospital = req.hospital;
    if (name !== undefined && (!clean(name) || clean(name).length > 180))
        return fail(res, 400, 'Hospital name is required and must be under 180 characters.');
    if (currency !== undefined && !['INR', 'USD'].includes(currency))
        return fail(res, 400, 'Currency must be INR or USD.');
    if (email && !/^\S+@\S+\.\S+$/.test(email))
        return fail(res, 400, 'Provide a valid hospital contact email.');
    if (timeZone !== undefined) {
        try {
            new Intl.DateTimeFormat('en', { timeZone });
        }
        catch {
            return fail(res, 400, 'Provide a valid IANA time zone.');
        }
    }
    for (const key of ['name', 'address', 'city', 'state', 'phone', 'email', 'currency', 'timeZone'])
        if (req.body?.[key] !== undefined)
            hospital[key] = key === 'name' ? clean(req.body[key]) : clean(req.body[key]);
    await hospital.save();
    await audit(req.user._id, 'hospital.updated', 'Hospital', hospital._id, { changedFields: Object.keys(req.body || {}) });
    res.json(hospital);
}));
app.get('/api/patient/portal', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:portal:read'))
        return;
    if (!req.user.patientId)
        return fail(res, 403, 'This patient login is not linked to a patient profile. Contact the hospital administrator.');
    const patientId = req.user.patientId;
    const [patient, appointments, previousAppointments, appointmentRequests, calls, tasks, documents, followups, messages] = await Promise.all([
        Patient.findOne({ _id: patientId, isDemo: false }).select('displayName externalId phone email').lean(),
        Appointment.find({ patientId, isDemo: false, confirmedByStaff: true, status: 'Scheduled' }).sort({ scheduledAt: 1 }).populate('departmentId', 'name').lean(),
        Appointment.find({ patientId, isDemo: false, status: { $in: ['Completed', 'Cancelled'] } }).sort({ scheduledAt: -1 }).limit(50).populate('departmentId', 'name').lean(),
        Appointment.find({ patientId, isDemo: false, requestStatus: { $in: ['requested', 'reschedule_requested', 'cancellation_requested', 'rejected'] } }).sort({ requestedAt: -1 }).populate('departmentId', 'name').lean(),
        Call.find({ patientId, isDemo: false }).select('createdAt status category summary patientRequests language').sort({ createdAt: -1 }).limit(50).lean(),
        Task.find({ patientId, isDemo: false, status: { $nin: ['Cancelled'] } }).select('title status dueAt').sort({ dueAt: 1 }).lean(),
        DocumentChecklist.find({ patientId, isDemo: false }).select('name status appointmentId').sort({ createdAt: -1 }).lean(),
        FollowUp.find({ patientId, isDemo: false }).select('taskId dueAt status note').sort({ dueAt: 1 }).populate('taskId', 'title').lean(),
        PatientMessage.find({ patientId, isDemo: false, status: 'Approved', channel: 'Patient portal' }).select('body createdAt deliveryStatus').sort({ createdAt: -1 }).limit(100).lean()
    ]);
    if (!patient)
        return fail(res, 404, 'Linked patient profile is unavailable.');
    res.json({ patient, appointments, previousAppointments, appointmentRequests, callSummaries: calls, tasks, documents, followups, messages, mode: 'patient-owned-live-records' });
}));
app.post('/api/patient/appointments', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:portal:read'))
        return;
    const patientId = req.user.patientId;
    const departmentId = req.body?.departmentId;
    const scheduledAt = new Date(req.body?.scheduledAt);
    if (!patientId || !parseId(departmentId) || Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date())
        return fail(res, 400, 'Choose a department and a future preferred date and time.');
    const department = await Department.findOne({ _id: departmentId, isDemo: false, $or: [{ active: true }, { active: { $exists: false } }] });
    if (!department)
        return fail(res, 404, 'Department is unavailable.');
    const appointment = await Appointment.create({ patientId, departmentId, scheduledAt, requestedScheduledAt: scheduledAt, requestStatus: 'requested', requestedAt: new Date(), patientRequestNote: clean(req.body?.note).slice(0, 500), confirmedByStaff: false, status: 'Scheduled', isDemo: false, createdBy: req.user._id });
    await audit(req.user._id, 'patient.appointment_requested', 'Appointment', appointment._id);
    res.status(201).json({ id: appointment.id, requestStatus: appointment.requestStatus, requestedAt: appointment.requestedAt });
}));
app.post('/api/patient/appointments/:id/reschedule', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:portal:read'))
        return;
    const date = new Date(req.body?.scheduledAt);
    if (!req.user.patientId || !parseId(req.params.id) || Number.isNaN(date.getTime()) || date <= new Date())
        return fail(res, 400, 'Choose a valid future date and time.');
    const appointment = await Appointment.findOne({ _id: req.params.id, patientId: req.user.patientId, isDemo: false, confirmedByStaff: true, status: 'Scheduled' });
    if (!appointment)
        return fail(res, 404, 'Confirmed appointment not found.');
    appointment.requestStatus = 'reschedule_requested';
    appointment.requestedScheduledAt = date;
    appointment.requestedAt = new Date();
    appointment.patientRequestNote = clean(req.body?.note).slice(0, 500);
    await appointment.save();
    await audit(req.user._id, 'patient.appointment_reschedule_requested', 'Appointment', appointment._id);
    res.json({ requestStatus: appointment.requestStatus, requestedAt: appointment.requestedAt });
}));
app.post('/api/patient/appointments/:id/cancel', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:portal:read'))
        return;
    if (!req.user.patientId || !parseId(req.params.id))
        return fail(res, 400, 'Invalid appointment.');
    const appointment = await Appointment.findOne({ _id: req.params.id, patientId: req.user.patientId, isDemo: false, confirmedByStaff: true, status: 'Scheduled' });
    if (!appointment)
        return fail(res, 404, 'Upcoming confirmed appointment not found.');
    if (appointment.requestStatus === 'cancellation_requested')
        return fail(res, 409, 'A cancellation request is already waiting for staff review.');
    appointment.requestStatus = 'cancellation_requested';
    appointment.requestedAt = new Date();
    appointment.patientRequestNote = clean(req.body?.note).slice(0, 500);
    await appointment.save();
    await audit(req.user._id, 'patient.appointment_cancellation_requested', 'Appointment', appointment._id);
    res.json({ requestStatus: appointment.requestStatus, requestedAt: appointment.requestedAt });
}));
app.get('/api/users', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'user:manage'))
        return;
    res.json(await HospitalMembership.find({ hospitalId: req.hospital._id }).populate({ path: 'userId', select: 'name email active createdAt' }).populate('departmentId', 'name code active').sort({ role: 1 }).lean());
}));
app.post('/api/users', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'user:manage'))
        return;
    const name = clean(req.body?.name), email = clean(req.body?.email).toLowerCase(), password = req.body?.password;
    const role = accountRoles.includes(req.body?.role) ? req.body.role : 'staff';
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 12)
        return fail(res, 400, 'Provide a name, valid email, and password with at least 12 characters.');
    if (req.body?.active !== undefined && typeof req.body.active !== 'boolean')
        return fail(res, 400, 'Account status must be active or inactive.');
    const active = req.body?.active !== false;
    if (await runWithoutHospital(async () => await User.exists({ email })))
        return fail(res, 409, 'This email already has an account. Use Grant hospital access for an existing account.');
    if (req.body?.departmentId && (!parseId(req.body.departmentId) || !await Department.exists({ _id: req.body.departmentId })))
        return fail(res, 400, 'Department is not part of this hospital.');
    if (role === 'patient' && (!parseId(req.body?.patientId) || !await Patient.exists({ _id: req.body.patientId, isDemo: false })))
        return fail(res, 400, 'Patient accounts must be linked to one existing live patient record.');
    const employeeId = clean(req.body?.employeeId || req.body?.staffId).toUpperCase().slice(0, 80);
    const departmentId = req.body?.departmentId || null;
    if (req.body?.departmentId && (!parseId(req.body.departmentId) || !await Department.exists({ _id: req.body.departmentId, active: { $ne: false } })))
        return fail(res, 400, 'Department is not active in this hospital.');
    const user = await User.create({ hospitalId: req.hospital._id, hospitalIds: [req.hospital._id], name, email, role, departmentId, patientId: role === 'patient' ? req.body.patientId : null, passwordHash: await bcrypt.hash(password, 12), active });
    let membership;
    try {
        membership = await HospitalMembership.create({ hospitalId: req.hospital._id, userId: user._id, role, departmentId, employeeId, jobTitle: clean(req.body?.jobTitle).slice(0, 120), phone: clean(req.body?.phone).slice(0, 40), patientId: role === 'patient' ? req.body.patientId : null, active });
    }
    catch (error) {
        await runWithoutHospital(() => User.deleteOne({ _id: user._id }));
        throw error;
    }
    await audit(req.user._id, 'user.created', 'User', user._id, { role });
    res.status(201).json({ id: user.id, membershipId: membership.id, employeeId, name: user.name, email: user.email, role: user.role, departmentId, jobTitle: membership.jobTitle, phone: membership.phone, active, patientId: user.patientId || null });
}));
app.post('/api/users/membership', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'user:manage'))
        return;
    const email = clean(req.body?.email).toLowerCase();
    const role = accountRoles.includes(req.body?.role) ? req.body.role : 'staff';
    if (!/^\S+@\S+\.\S+$/.test(email))
        return fail(res, 400, 'Enter the existing account email to grant this hospital access.');
    const user = await runWithoutHospital(async () => await User.findOne({ email, active: true }));
    if (!user)
        return fail(res, 404, 'No active account is registered with that email. Ask the person to create an account first.');
    const existing = await HospitalMembership.findOne({ hospitalId: req.hospital._id, userId: user._id });
    if (existing)
        return fail(res, 409, 'This account already has a membership in the selected hospital.');
    if (role === 'patient' && (!parseId(req.body?.patientId) || !await Patient.exists({ _id: req.body.patientId, isDemo: false })))
        return fail(res, 400, 'Patient accounts must link to a live patient record in this hospital.');
    await runInHospital(String(req.hospital._id), async () => {
        user.hospitalIds = [...(user.hospitalIds || []), req.hospital._id];
        user.hospitalId ||= req.hospital._id;
        await user.save();
        await HospitalMembership.create({ hospitalId: req.hospital._id, userId: user._id, role, departmentId: parseId(req.body?.departmentId) ? req.body.departmentId : null, patientId: role === 'patient' ? req.body.patientId : null, active: true });
    });
    await audit(req.user._id, 'user.membership.created', 'HospitalMembership', user._id, { role });
    res.status(201).json({ message: 'Hospital access granted.', user: { id: user.id, name: user.name, email: user.email, role } });
}));
app.patch('/api/users/:id/membership', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'user:manage'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid user ID.');
    const membership = await HospitalMembership.findOne({ hospitalId: req.hospital._id, userId: req.params.id });
    if (!membership)
        return fail(res, 404, 'Hospital membership not found.');
    const nextRole = req.body?.role;
    const nextActive = req.body?.active;
    if (nextRole !== undefined && !accountRoles.includes(nextRole))
        return fail(res, 400, 'Unsupported hospital role.');
    if (nextRole === 'patient' && await Department.exists({ managerStaffId: membership._id }))
        return fail(res, 409, 'Remove this staff member as department manager before changing to a patient role.');
    if (nextActive === false && membership.active && membership.role === 'admin' && await HospitalMembership.countDocuments({ hospitalId: req.hospital._id, role: 'admin', active: true }) <= 1)
        return fail(res, 409, 'The final active hospital administrator cannot be deactivated.');
    if (nextRole && membership.role === 'admin' && nextRole !== 'admin' && await HospitalMembership.countDocuments({ hospitalId: req.hospital._id, role: 'admin', active: true }) <= 1)
        return fail(res, 409, 'Assign another hospital administrator before changing this role.');
    if (nextRole)
        membership.role = nextRole;
    if (typeof nextActive === 'boolean') {
        membership.active = nextActive;
        if (!nextActive)
            await Department.updateOne({ managerStaffId: membership._id }, { $set: { managerStaffId: null } });
    }
    if (req.body?.patientId !== undefined) {
        if (membership.role !== 'patient' || !parseId(req.body.patientId) || !await Patient.exists({ _id: req.body.patientId, isDemo: false }))
            return fail(res, 400, 'Patient account links must point to a live patient record in this hospital.');
        membership.patientId = req.body.patientId;
    }
    if (req.body?.departmentId !== undefined) {
        if (req.body.departmentId && (!parseId(req.body.departmentId) || !await Department.exists({ _id: req.body.departmentId, active: { $ne: false } })))
            return fail(res, 400, 'Department is not active in this hospital.');
        membership.departmentId = req.body.departmentId || null;
    }
    await membership.save();
    await audit(req.user._id, 'user.membership.updated', 'HospitalMembership', membership._id, { role: membership.role, active: membership.active });
    res.json({ id: membership.id, role: membership.role, departmentId: membership.departmentId, active: membership.active });
}));
app.get('/api/workspace', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'workspace:read'))
        return;
    const filter = modeFilter(req);
    const [calls, tasks, appointments, patients, departments, followups] = await Promise.all([
        Call.find(filter).sort({ createdAt: -1 }).limit(100).populate('patientId', 'displayName externalId isDemo').populate('assignedTo', 'name').lean(),
        Task.find(filter).sort({ createdAt: -1 }).limit(200).populate('patientId', 'displayName externalId isDemo').populate('departmentId', 'name').populate('assignedTo', 'name').lean(),
        Appointment.find(filter).sort({ scheduledAt: 1 }).limit(100).populate('patientId', 'displayName externalId isDemo').populate('departmentId', 'name').lean(),
        Patient.find(filter).sort({ createdAt: -1 }).limit(200).lean(),
        Department.find({ isDemo: isDemoMode(req) }).sort({ name: 1 }).lean(),
        FollowUp.find({ ...modeFilter(req), status: 'Pending' }).sort({ dueAt: 1 }).limit(100).populate('taskId', 'title status dueAt').lean()
    ]);
    const safePatients = patients.map(p => staffSafePatient(p, req.user.role));
    const mode = modeFilter(req);
    const dayStart = startOfDayInZone(req.hospital.timeZone || 'Asia/Kolkata');
    const dayEnd = startOfDayInZone(req.hospital.timeZone || 'Asia/Kolkata', new Date(dayStart.getTime() + 36 * 60 * 60 * 1000));
    const [patientCount, appointmentToday, staffCount, pendingAdmissions, pendingDischarges, openInsurance, pendingBilling, overdueTasks, callCount, taskCount, pendingActions, completedFollowUps] = await Promise.all([
        Patient.countDocuments(mode), Appointment.countDocuments({ ...mode, status: 'Scheduled', scheduledAt: { $gte: dayStart, $lt: dayEnd } }),
        HospitalMembership.countDocuments({ hospitalId: req.hospital._id, active: true, role: { $ne: 'patient' } }),
        Admission.countDocuments({ ...mode, status: { $nin: ['Verified', 'Cancelled'] } }), Discharge.countDocuments({ ...mode, status: { $nin: ['Completed', 'Cancelled'] } }),
        InsuranceCase.countDocuments({ ...mode, status: { $nin: ['Verified', 'Closed'] } }), BillingRecord.countDocuments({ ...mode, paymentStatus: { $in: ['Unknown', 'Pending', 'Disputed'] } }),
        Task.countDocuments({ ...mode, dueAt: { $lt: new Date() }, status: { $nin: ['Completed', 'Cancelled'] } }),
        Call.countDocuments(mode), Task.countDocuments(mode), Task.countDocuments({ ...mode, status: { $in: ['Pending', 'Pending Confirmation'] } }), FollowUp.countDocuments({ ...mode, status: 'Completed' })
    ]);
    res.json({ mode: isDemoMode(req) ? 'demo' : 'live', calls, tasks, appointments, patients: safePatients, departments, followups, totals: { calls: callCount, tasks: taskCount, actionsGenerated: taskCount, pendingActions, completedFollowUps, patients: patientCount, appointments: appointments.length, appointmentToday, staff: staffCount, pendingAdmissions, pendingDischarges, openInsurance, pendingBilling, overdueTasks, openTasks: tasks.filter(t => !['Completed', 'Cancelled'].includes(t.status)).length } });
}));
app.get('/api/departments', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'directory:read'))
        return;
    const departments = await Department.find({ isDemo: isDemoMode(req), ...(req.user.role === 'admin' ? {} : { $or: [{ active: true }, { active: { $exists: false } }] }) }).sort({ name: 1 }).lean();
    const ids = departments.map(d => d._id);
    const counts = await HospitalMembership.aggregate([{ $match: { hospitalId: req.hospital._id, departmentId: { $in: ids }, role: { $ne: 'patient' } } }, { $group: { _id: '$departmentId', total: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } } } }]);
    const countMap = new Map(counts.map(c => [String(c._id), c]));
    res.json(departments.map(d => ({ ...d, code: d.code || '', active: d.active !== false, staffCount: countMap.get(String(d._id))?.total || 0, activeStaffCount: countMap.get(String(d._id))?.active || 0 })));
}));
app.get('/api/departments/:id', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'directory:read'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid department identifier.');
    const department = await Department.findOne({ _id: req.params.id, isDemo: isDemoMode(req) }).populate({ path: 'managerStaffId', populate: { path: 'userId', select: 'name email' } }).lean();
    if (!department || (req.user.role !== 'admin' && department.active === false))
        return fail(res, 404, 'Department not found.');
    const counts = await HospitalMembership.aggregate([{ $match: { hospitalId: req.hospital._id, departmentId: department._id, role: { $ne: 'patient' } } }, { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } } } }]);
    res.json({ ...department, code: department.code || '', active: department.active !== false, staffCount: counts[0]?.total || 0, activeStaffCount: counts[0]?.active || 0 });
}));
const defaultDepartments = [
    ['Appointment & Scheduling', 'APPT', 'Handles appointment scheduling requests'], ['Patient Support', 'PSUP', 'Supports patient service and navigation requests'], ['Billing & Insurance', 'BILL', 'Handles billing and insurance enquiries'], ['Medical Records', 'MREC', 'Coordinates medical record requests'], ['Clinical Review', 'CLIN', 'Routes clinical questions to authorized clinicians'], ['Laboratory Services', 'LAB', 'Coordinates laboratory service enquiries'], ['Administration', 'ADMIN', 'Hospital administrative operations'], ['Call Center', 'CALL', 'Manages incoming and outgoing calls'], ['IT & Systems', 'IT', 'Supports hospital information systems'], ['Hospital Operations', 'OPS', 'Coordinates hospital operational services']
];
app.post('/api/departments/initialize', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can initialize departments.');
    let created = 0;
    for (const [name, code, description] of defaultDepartments) {
        const exists = await Department.exists({ code, isDemo: isDemoMode(req) });
        if (exists)
            continue;
        const byName = await Department.findOne({ name, isDemo: isDemoMode(req) });
        if (byName) {
            if (!byName.code) {
                byName.code = code;
                await byName.save();
            }
            continue;
        }
        await Department.create({ name, code, description, active: true, isDemo: isDemoMode(req), createdBy: req.user._id });
        created++;
    }
    await audit(req.user._id, 'department.defaults_initialized', 'Department', '', { created, mode: isDemoMode(req) ? 'demo' : 'live' });
    res.json({ created, message: created ? `${created} missing departments initialized.` : 'Default departments already exist.' });
}));
app.post('/api/departments', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can manage departments.');
    const name = clean(req.body?.name);
    const code = clean(req.body?.code).toUpperCase();
    if (!name || name.length > 100)
        return fail(res, 400, 'Department name is required (100 characters maximum).');
    if (!/^[A-Z0-9_-]{2,16}$/.test(code))
        return fail(res, 400, 'Enter a department code (2–16 letters, numbers, hyphens, or underscores).');
    const department = await Department.create({ name, code, description: clean(req.body?.description).slice(0, 500), active: true, isDemo: isDemoMode(req), createdBy: req.user._id });
    await audit(req.user._id, 'department.created', 'Department', department._id);
    res.status(201).json(department);
}));
app.patch('/api/departments/:id', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can manage departments.');
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid department identifier.');
    const department = await Department.findOne({ _id: req.params.id, ...modeFilter(req) });
    if (!department)
        return fail(res, 404, 'Department not found.');
    if (req.body?.name !== undefined) {
        const name = clean(req.body.name);
        if (!name || name.length > 100)
            return fail(res, 400, 'Department name is required (100 characters maximum).');
        department.name = name;
    }
    if (req.body?.code !== undefined) {
        const code = clean(req.body.code).toUpperCase();
        if (!/^[A-Z0-9_-]{2,16}$/.test(code))
            return fail(res, 400, 'Enter a valid department code.');
        department.code = code;
    }
    if (req.body?.description !== undefined)
        department.description = clean(req.body.description).slice(0, 500);
    if (req.body?.active !== undefined) {
        if (typeof req.body.active !== 'boolean')
            return fail(res, 400, 'Department active state must be a boolean.');
        department.active = req.body.active;
        if (!req.body.active)
            department.managerStaffId = null;
    }
    if (req.body?.managerStaffId !== undefined) {
        if (req.body.managerStaffId === null || req.body.managerStaffId === '')
            department.managerStaffId = null;
        else {
            if (!parseId(req.body.managerStaffId))
                return fail(res, 400, 'Invalid staff membership identifier.');
            const manager = await HospitalMembership.findOne({ _id: req.body.managerStaffId, hospitalId: req.hospital._id, departmentId: department._id, active: true, role: { $ne: 'patient' } });
            if (!manager)
                return fail(res, 400, 'Manager must be active staff assigned to this department.');
            department.managerStaffId = manager._id;
        }
    }
    await department.save();
    await audit(req.user._id, 'department.updated', 'Department', department._id, { active: department.active, managerStaffId: department.managerStaffId });
    res.json(department);
}));
app.get('/api/departments/:id/staff', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can view staff management records.');
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid department identifier.');
    if (!await Department.exists({ _id: req.params.id, isDemo: isDemoMode(req) }))
        return fail(res, 404, 'Department not found.');
    const rows = await HospitalMembership.find({ hospitalId: req.hospital._id, departmentId: req.params.id, role: { $ne: 'patient' } }).populate({ path: 'userId', select: 'name email active createdAt' }).populate('departmentId', 'name code active').sort({ employeeId: 1 }).lean();
    res.json(rows.filter(row => row.userId).map(row => ({ ...row, fullName: row.userId.name, email: row.userId.email, isActive: row.active && row.userId.active !== false })));
}));
app.post('/api/staff', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can create staff.');
    const name = clean(req.body?.name), email = clean(req.body?.email).toLowerCase(), employeeId = clean(req.body?.employeeId).toUpperCase(), jobTitle = clean(req.body?.jobTitle), password = req.body?.password;
    const departmentId = req.body?.departmentId, role = req.body?.role;
    if (!name || name.length > 120 || !/^\S+@\S+\.\S+$/.test(email) || !employeeId || employeeId.length > 80 || !jobTitle || jobTitle.length > 120)
        return fail(res, 400, 'Provide a full name, valid email, employee ID, and job title.');
    if (!parseId(departmentId) || !await Department.exists({ _id: departmentId, isDemo: isDemoMode(req), active: { $ne: false } }))
        return fail(res, 400, 'Choose an active department in this hospital.');
    if (!accountRoles.includes(role) || ['admin', 'patient'].includes(role))
        return fail(res, 400, 'Choose a non-administrator staff access role.');
    if (typeof password !== 'string' || password.length < 12)
        return fail(res, 400, 'Initial password must contain at least 12 characters.');
    const active = req.body?.active !== false;
    if (req.body?.active !== undefined && typeof req.body.active !== 'boolean')
        return fail(res, 400, 'Account status must be active or inactive.');
    if (await runWithoutHospital(() => User.exists({ email })))
        return fail(res, 409, 'This email already has an account. Use the existing-account access flow instead.');
    if (await HospitalMembership.exists({ employeeId }))
        return fail(res, 409, 'This employee ID is already used in this hospital.');
    const user = await User.create({ hospitalId: req.hospital._id, hospitalIds: [req.hospital._id], name, email, role, departmentId, passwordHash: await bcrypt.hash(password, 12), active: true });
    let membership;
    try {
        membership = await HospitalMembership.create({ hospitalId: req.hospital._id, userId: user._id, role, departmentId, employeeId, jobTitle, phone: clean(req.body?.phone).slice(0, 40), active });
    }
    catch (error) {
        await runWithoutHospital(() => User.deleteOne({ _id: user._id }));
        throw error;
    }
    await audit(req.user._id, 'staff.created', 'HospitalMembership', membership._id, { departmentId, role, employeeId });
    res.status(201).json({ _id: membership._id, userId: { _id: user._id, name, email, active: true }, membershipId: membership._id, fullName: name, employeeId, email, jobTitle, departmentId, role, phone: membership.phone, active, isActive: active });
}));
app.get('/api/staff', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'user:manage'))
        return;
    if (req.query.departmentId && !parseId(req.query.departmentId))
        return fail(res, 400, 'Invalid department identifier.');
    const filter = { hospitalId: req.hospital._id, role: { $ne: 'patient' }, ...(parseId(req.query.departmentId) ? { departmentId: req.query.departmentId } : {}) };
    const rows = await HospitalMembership.find(filter).populate({ path: 'userId', select: 'name email active createdAt' }).populate('departmentId', 'name code active').sort({ employeeId: 1 }).lean();
    const q = clean(req.query.q).toLowerCase();
    const title = clean(req.query.jobTitle).toLowerCase();
    const status = clean(req.query.status);
    res.json(rows.filter(row => row.userId && (!q || `${row.employeeId} ${row.userId.name} ${row.userId.email}`.toLowerCase().includes(q)) && (!title || row.jobTitle.toLowerCase().includes(title)) && (!status || (status === 'active') === (row.active && row.userId.active !== false))).map(row => ({ ...row, fullName: row.userId.name, email: row.userId.email, isActive: row.active && row.userId.active !== false })));
}));
app.get('/api/staff/:id', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can view staff management records.');
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid staff membership identifier.');
    const row = await HospitalMembership.findOne({ _id: req.params.id, hospitalId: req.hospital._id, role: { $ne: 'patient' } }).populate({ path: 'userId', select: 'name email active createdAt' }).populate('departmentId', 'name code active').lean();
    if (!row?.userId)
        return fail(res, 404, 'Staff member not found.');
    res.json({ ...row, fullName: row.userId.name, email: row.userId.email, isActive: row.active && row.userId.active !== false });
}));
app.patch('/api/staff/:id', asyncRoute(async (req, res) => {
    if (req.user.role !== 'admin')
        return fail(res, 403, 'Only a hospital administrator can manage staff.');
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid staff membership identifier.');
    const membership = await HospitalMembership.findOne({ _id: req.params.id, hospitalId: req.hospital._id, role: { $ne: 'patient' } });
    if (!membership)
        return fail(res, 404, 'Staff membership not found.');
    const before = { departmentId: membership.departmentId ? String(membership.departmentId) : null, role: membership.role, active: membership.active };
    const user = await runWithoutHospital(() => User.findById(membership.userId));
    if (!user)
        return fail(res, 404, 'Staff account not found.');
    const changes = {};
    if (req.body?.name !== undefined) {
        const v = clean(req.body.name);
        if (!v || v.length > 120)
            return fail(res, 400, 'Full name is required.');
        user.name = v;
    }
    if (req.body?.email !== undefined) {
        const v = clean(req.body.email).toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(v))
            return fail(res, 400, 'Enter a valid email.');
        user.email = v;
    }
    if (req.body?.employeeId !== undefined) {
        const v = clean(req.body.employeeId).toUpperCase();
        if (!v || v.length > 80)
            return fail(res, 400, 'Employee ID is required.');
        changes.employeeId = v;
    }
    if (req.body?.jobTitle !== undefined) {
        const v = clean(req.body.jobTitle);
        if (!v || v.length > 120)
            return fail(res, 400, 'Job title is required.');
        changes.jobTitle = v;
    }
    if (req.body?.phone !== undefined)
        changes.phone = clean(req.body.phone).slice(0, 40);
    if (req.body?.departmentId !== undefined) {
        const nextId = req.body.departmentId;
        if (!parseId(nextId) || !await Department.exists({ _id: nextId, isDemo: isDemoMode(req), active: { $ne: false } }))
            return fail(res, 400, 'Destination department must exist and be active.');
        if (String(membership.departmentId) !== String(nextId)) {
            changes.departmentId = nextId;
            await Department.updateOne({ managerStaffId: membership._id }, { $set: { managerStaffId: null } });
        }
    }
    if (req.body?.role !== undefined) {
        if (!accountRoles.includes(req.body.role) || req.body.role === 'patient')
            return fail(res, 400, 'Choose a staff access role.');
        changes.role = req.body.role;
    }
    if (req.body?.active !== undefined) {
        if (typeof req.body.active !== 'boolean')
            return fail(res, 400, 'Account status must be active or inactive.');
        changes.active = req.body.active;
        if (req.body.active === false)
            await Department.updateOne({ managerStaffId: membership._id }, { $set: { managerStaffId: null } });
    }
    await user.save();
    Object.assign(membership, changes);
    await membership.save();
    await audit(req.user._id, req.body?.departmentId && before.departmentId !== String(membership.departmentId) ? 'staff.reassigned' : 'staff.updated', 'HospitalMembership', membership._id, { before, after: { departmentId: membership.departmentId ? String(membership.departmentId) : null, active: membership.active, role: membership.role } });
    const saved = await HospitalMembership.findById(membership._id).populate({ path: 'userId', select: 'name email active createdAt' }).populate('departmentId', 'name code active').lean();
    res.json({ ...saved, fullName: saved.userId?.name, email: saved.userId?.email, isActive: saved.active && saved.userId?.active !== false });
}));
app.get('/api/patients', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:read'))
        return;
    const q = clean(req.query.q);
    const filter = { ...modeFilter(req), ...(q ? { $or: [{ displayName: new RegExp(escapeRegex(q), 'i') }, { externalId: new RegExp(escapeRegex(q), 'i') }] } : {}) };
    const rows = await Patient.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map(p => staffSafePatient(p, req.user.role)));
}));
app.post('/api/patients', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:write'))
        return;
    const displayName = clean(req.body?.displayName);
    if (!displayName)
        return fail(res, 400, 'Patient display name is required.');
    if (req.body?.consentToProcessing !== undefined && typeof req.body.consentToProcessing !== 'boolean')
        return fail(res, 400, 'Consent must be explicitly true or false.');
    const rawPhone = clean(req.body?.phone);
    const phoneVerified = req.body?.phoneVerified === true;
    const phone = rawPhone ? normalizeIndiaNumber(rawPhone) : '';
    if (rawPhone && !phone)
        return fail(res, 400, 'Enter a valid Indian mobile number (10 digits or +91 E.164).');
    if (phoneVerified && !phone)
        return fail(res, 400, 'A phone number is required before marking it verified.');
    const patient = await Patient.create({ displayName, externalId: clean(req.body?.externalId), phone, phoneVerified, phoneVerifiedAt: phoneVerified ? new Date() : null, phoneVerifiedBy: phoneVerified ? req.user._id : null, email: clean(req.body?.email), consentToProcessing: req.body?.consentToProcessing === true, isDemo: isDemoMode(req), createdBy: req.user._id });
    await audit(req.user._id, 'patient.created', 'Patient', patient._id, { isDemo: patient.isDemo });
    res.status(201).json(staffSafePatient(patient, req.user.role));
}));
app.patch('/api/patients/:id/verify-phone', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid patient identifier.');
    const phone = normalizeIndiaNumber(req.body?.phone);
    if (!phone || req.body?.confirmed !== true)
        return fail(res, 400, 'Provide an Indian mobile number and confirm it was verified from an authorized source.');
    const patient = await Patient.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req) }, { $set: { phone, phoneVerified: true, phoneVerifiedAt: new Date(), phoneVerifiedBy: req.user._id } }, { new: true });
    if (!patient)
        return fail(res, 404, 'Patient record not found in the selected data mode.');
    await audit(req.user._id, 'patient.phone_verified', 'Patient', patient._id, { phoneLast4: phone.slice(-4) });
    res.json(staffSafePatient(patient, req.user.role));
}));
app.get('/api/calls', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:read'))
        return;
    const status = clean(req.query.status);
    const filter = { ...modeFilter(req), ...(status ? { status } : {}) };
    res.json(await populateCall(Call.find(filter).sort({ createdAt: -1 }).limit(200)).lean());
}));
app.post('/api/calls', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    const callerLabel = clean(req.body?.callerLabel) || 'Unverified caller';
    const patientId = req.body?.patientId;
    if (patientId && !parseId(patientId))
        return fail(res, 400, 'Invalid patient record identifier.');
    if (patientId) {
        const patient = await Patient.findOne({ _id: patientId, ...modeFilter(req) });
        if (!patient)
            return fail(res, 404, 'Patient record was not found in the selected data mode.');
    }
    const call = await Call.create({ callerLabel, patientId: patientId || null, direction: req.body?.direction === 'outgoing' ? 'outgoing' : 'incoming', status: 'active', language: req.body?.language || 'Unknown', isDemo: isDemoMode(req), createdBy: req.user._id, assignedTo: req.user._id });
    await audit(req.user._id, 'call.created', 'Call', call._id, { isDemo: call.isDemo });
    res.status(201).json(await populateCall(Call.findById(call._id)));
}));
const callStartLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Call initiation limit reached. Wait before placing another call.' } });
app.post('/api/calls/outbound', callStartLimiter, asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!exotelConfiguration())
        return fail(res, 503, 'Real phone calling is not configured. Add Exotel backend credentials, caller ID, HTTPS public callback URL and webhook token. No call was placed.');
    if (isDemoMode(req))
        return fail(res, 400, 'Real calls are disabled in Synthetic demo mode. Switch to Live records and select a verified live patient.');
    const patientId = req.body?.patientId;
    const clientRequestId = clean(req.body?.clientRequestId);
    const staffPhone = normalizeIndiaNumber(req.body?.staffPhone);
    if (!parseId(patientId) || !staffPhone || !/^[A-Za-z0-9_-]{12,80}$/.test(clientRequestId))
        return fail(res, 400, 'Select a patient, enter the agent phone in India format, and provide a valid call request ID.');
    if (req.body?.authorizedToCall !== true)
        return fail(res, 400, 'Confirm you are authorized to call this patient.');
    const previous = await Call.findOne({ clientRequestId, isDemo: false });
    if (previous)
        return res.json({ call: await populateCall(Call.findById(previous._id)), duplicateRequest: true });
    const patient = await Patient.findOne({ _id: patientId, isDemo: false }).select('+phone');
    if (!patient)
        return fail(res, 404, 'Live patient record not found.');
    if (!patient.phone || !patient.phoneVerified || !normalizeIndiaNumber(patient.phone))
        return fail(res, 409, 'This patient has no verified Indian phone number. Verify the number in Patient Records before calling.');
    const call = await Call.create({ callerLabel: patient.displayName, patientId: patient._id, direction: 'outgoing', status: 'active', callState: 'Initiating', telephonyProvider: 'exotel', providerStatus: 'queued', clientRequestId, callConsentConfirmedAt: new Date(), recordingConsentConfirmedAt: req.body?.recordingConsentConfirmed === true ? new Date() : null, verificationStatus: 'unverified', patientPhoneLast4: patient.phone.slice(-4), agentPhoneLast4: staffPhone.slice(-4), isDemo: false, createdBy: req.user._id, assignedTo: req.user._id });
    await audit(req.user._id, 'call.outbound_requested', 'Call', call._id, { provider: 'exotel', recordingConsent: Boolean(call.recordingConsentConfirmedAt) });
    try {
        const accepted = await initiateExotelCall({ staffPhone, patientPhone: normalizeIndiaNumber(patient.phone), callId: String(call._id), record: Boolean(call.recordingConsentConfirmedAt) });
        call.providerCallId = accepted.sid;
        // Preserve any callback that raced ahead of this HTTP response. API acceptance alone
        // is not evidence that the patient answered.
        if (call.callState === 'Initiating')
            call.providerStatus = accepted.providerStatus;
        await call.save();
        await audit(req.user._id, 'call.exotel_accepted', 'Call', call._id, { providerCallId: accepted.sid });
        return res.status(202).json({ call: await populateCall(Call.findById(call._id)), message: 'Exotel accepted the request. Waiting for a provider status callback; this is not yet confirmation that the patient answered.' });
    }
    catch (error) {
        call.providerStatus = 'submission_unknown';
        await call.save();
        await audit(req.user._id, 'call.exotel_submission_error', 'Call', call._id, { message: String(error?.message || error).slice(0, 300) });
        return fail(res, 502, 'Exotel did not confirm the call request. Check provider logs before retrying; the call state remains unconfirmed to avoid duplicate calls.', String(error?.message || error).slice(0, 300));
    }
}));
app.get('/api/calls/:id', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:read'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    const call = await populateCall(Call.findOne({ _id: req.params.id, ...modeFilter(req) }));
    if (!call)
        return fail(res, 404, 'Call record not found.');
    res.json(call);
}));
app.post('/api/calls/:id/provider-status', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:read'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req), telephonyProvider: 'exotel' });
    if (!call)
        return fail(res, 404, 'Exotel call record not found.');
    if (!call.providerCallId)
        return fail(res, 409, 'Waiting for Exotel to return the call ID.');
    try {
        const provider = await getExotelCallStatus(call.providerCallId);
        const next = mapExotelStatus(provider.status);
        if (!next)
            return fail(res, 502, 'Exotel returned an unrecognized call status; the stored call state was left unchanged.');
        const terminalStates = ['Completed', 'Busy', 'No Answer', 'Failed'];
        const wasTerminal = terminalStates.includes(call.callState);
        const isTerminal = terminalStates.includes(next);
        if (!wasTerminal || isTerminal) {
            call.providerStatus = provider.status;
            call.callState = next;
            if (next === 'In Progress' || next === 'Connected')
                call.connectedAt ||= new Date();
            if (Number.isFinite(provider.durationSeconds) && provider.durationSeconds >= 0)
                call.durationSeconds = provider.durationSeconds;
        }
        if (!wasTerminal && isTerminal) {
            call.status = next === 'Completed' ? 'completed' : next === 'Failed' ? 'abandoned' : 'missed';
            call.endedAt = new Date();
        }
        await call.save();
        return res.json(await populateCall(Call.findById(call._id)));
    }
    catch (error) {
        return fail(res, 502, 'Could not refresh call status from Exotel.', String(error?.message || error).slice(0, 300));
    }
}));
app.post('/api/calls/:id/transcript', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    const text = clean(req.body?.text);
    const speakers = ['Doctor', 'Nurse', 'Patient', 'Caregiver', 'Staff', 'Unknown'];
    const speaker = speakers.includes(req.body?.speaker) ? req.body.speaker : 'Unknown';
    if (!text || text.length > 8000)
        return fail(res, 400, 'Transcript text is required and must be under 8,000 characters.');
    const call = await Call.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req), status: 'active' }, { $push: { transcript: { speaker, text, uncertain: Boolean(req.body?.uncertain), confidence: null, editedBy: req.user._id } } }, { new: true });
    if (!call)
        return fail(res, 404, 'Active call not found.');
    await audit(req.user._id, 'call.transcript_segment_added', 'Call', call._id, { speaker });
    res.status(201).json(call);
}));
app.patch('/api/calls/:id/transcript/:segmentId', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id) || !parseId(req.params.segmentId))
        return fail(res, 400, 'Invalid call or transcript segment identifier.');
    const text = clean(req.body?.text);
    if (!text || text.length > 8000)
        return fail(res, 400, 'Corrected transcript text is required.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req), 'transcript._id': req.params.segmentId });
    if (!call)
        return fail(res, 404, 'Transcript segment not found.');
    const segment = call.transcript.id(req.params.segmentId);
    if (!segment.originalText)
        segment.originalText = segment.text;
    segment.text = text;
    segment.editedBy = req.user._id;
    segment.editedAt = new Date();
    await call.save();
    await audit(req.user._id, 'call.transcript_corrected', 'Call', call._id);
    res.json(call);
}));
app.post('/api/calls/:id/end', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req), status: 'active' });
    if (!call)
        return fail(res, 404, 'Active call not found.');
    if (call.telephonyProvider === 'exotel') {
        if (!call.providerCallId)
            return fail(res, 409, 'Exotel has not returned a call ID, so remote termination cannot be confirmed.');
        try {
            await endExotelCall(call.providerCallId);
        }
        catch (error) {
            return fail(res, 502, 'Exotel could not confirm remote call termination. The call stays active until a provider callback confirms its state.', String(error?.message || error).slice(0, 300));
        }
        await audit(req.user._id, 'call.exotel_hangup_requested', 'Call', call._id, { providerCallId: call.providerCallId });
        return res.status(202).json({ call, message: 'Hangup requested from Exotel. The call will show completed only after a terminal provider callback.' });
    }
    call.status = 'completed';
    call.callState = 'Completed';
    call.endedAt = new Date();
    await call.save();
    await audit(req.user._id, 'call.completed', 'Call', call._id);
    res.json(call);
}));
app.post('/api/calls/:id/verify', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'patient:write'))
        return;
    if (!parseId(req.params.id) || !parseId(req.body?.patientId))
        return fail(res, 400, 'Call and patient identifiers are required.');
    const patient = await Patient.findOne({ _id: req.body.patientId, ...modeFilter(req) });
    if (!patient)
        return fail(res, 404, 'Patient record not found in the selected data mode.');
    const call = await Call.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req) }, { $set: { patientId: patient._id, verificationStatus: 'verified', verifiedBy: req.user._id, verifiedAt: new Date() } }, { new: true });
    if (!call)
        return fail(res, 404, 'Call record not found.');
    await audit(req.user._id, 'call.patient_verified', 'Call', call._id);
    res.json(call);
}));
app.post('/api/calls/:id/analyze', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    if (!aiEnabled)
        return fail(res, 503, 'AI processing is not configured. Add OPENAI_API_KEY and set AI_EXTERNAL_PROCESSING_ENABLED=true after confirming your privacy and consent requirements.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req) }).populate('patientId');
    if (!call)
        return fail(res, 404, 'Call record not found.');
    if (!call.patientId || call.verificationStatus !== 'verified' || !call.patientId.consentToProcessing)
        return fail(res, 403, 'Verify the patient and record their consent for external AI processing before continuing.');
    const transcript = call.transcript.map(s => `${s.speaker}: ${s.text}`).join('\n');
    if (transcript.length < 12)
        return fail(res, 400, 'Add a transcript before requesting analysis.');
    const response = await openAIChat({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        messages: [
            { role: 'system', content: 'Extract only administrative information explicitly stated in the transcript. Do not produce diagnoses, treatment plans, or infer symptoms or deadlines. Return JSON with keys summary (string), patientRequests (array of strings), and proposedTasks (array of {description, responsibleRole, priority [Low|Medium|High], sourceExcerpt}). responsibleRole must be one of Appointment Staff, Patient Support Staff, Billing Staff, Clinical Review Staff, Administrator. Use dueAt only if the transcript explicitly gives a date; otherwise omit it. All tasks are unapproved drafts for staff review.' },
            { role: 'user', content: `Transcript (use no outside information):\n${transcript}` }
        ], response_format: { type: 'json_object' }
    });
    let result;
    try {
        result = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    }
    catch {
        return fail(res, 502, 'AI service returned an unreadable analysis. No changes were saved.');
    }
    const proposedTasks = (Array.isArray(result.proposedTasks) ? result.proposedTasks : []).slice(0, 15).map(t => {
        const explicitDueAt = t.dueAt && !Number.isNaN(Date.parse(t.dueAt)) ? new Date(t.dueAt) : null;
        return { description: clean(t.description).slice(0, 500), responsibleRole: responsibleRoles.includes(t.responsibleRole) ? t.responsibleRole : 'Patient Support Staff', departmentId: null, priority: ['Low', 'Medium', 'High'].includes(t.priority) ? t.priority : 'Medium', sourceExcerpt: clean(t.sourceExcerpt).slice(0, 1000), dueAt: explicitDueAt };
    }).filter(t => t.description);
    call.summary = clean(result.summary).slice(0, 5000);
    call.patientRequests = (Array.isArray(result.patientRequests) ? result.patientRequests : []).map(clean).filter(Boolean).slice(0, 20);
    call.proposedTasks = proposedTasks;
    call.analysisStatus = 'draft';
    call.analysisProvider = 'openai';
    await call.save();
    await audit(req.user._id, 'call.ai_analysis_created', 'Call', call._id, { provider: 'openai', proposals: proposedTasks.length });
    res.json({ call });
}));
app.post('/api/calls/:id/transcribe', upload.single('audio'), asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    if (!req.file)
        return fail(res, 400, 'Choose an audio file to transcribe.');
    if (!aiEnabled)
        return fail(res, 503, 'Speech transcription is not configured. Add the backend API key and explicitly enable external processing.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req) }).populate('patientId');
    if (!call)
        return fail(res, 404, 'Call record not found.');
    if (!call.patientId || call.verificationStatus !== 'verified' || !call.patientId.consentToProcessing)
        return fail(res, 403, 'Verify the patient and record their consent before external audio processing.');
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'audio.webm');
    form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
    form.append('response_format', 'verbose_json');
    const languageCodes = { Kannada: 'kn', English: 'en', Hindi: 'hi', Tamil: 'ta', Telugu: 'te' };
    if (languageCodes[call.language])
        form.append('language', languageCodes[call.language]);
    const speech = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
    const payload = await speech.json().catch(() => ({}));
    if (!speech.ok)
        return fail(res, 502, 'Speech service could not transcribe the recording.', clean(payload.error?.message).slice(0, 300));
    const text = clean(payload.text);
    if (!text)
        return fail(res, 422, 'Speech service returned no transcript.');
    call.transcript.push({ speaker: 'Unknown', text, uncertain: true, editedBy: req.user._id });
    const detected = Object.entries(languageCodes).find(([, code]) => code === payload.language)?.[0];
    if (detected)
        call.language = detected;
    call.recordingMetadata = { mimeType: req.file.mimetype, stored: false };
    if (call.status === 'active') {
        call.status = 'completed';
        call.endedAt = new Date();
    }
    await call.save();
    await audit(req.user._id, 'call.transcription_created', 'Call', call._id, { provider: 'openai', audioStored: false });
    res.json({ call, transcriptionProvider: 'openai', originalAudioStored: false, languageIdentification: 'provider result not retained by this prototype' });
}));
app.patch('/api/calls/:id/summary', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'call:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    if (typeof req.body?.summary !== 'string' || req.body.summary.length > 5000)
        return fail(res, 400, 'Summary is required and must be under 5,000 characters.');
    const call = await Call.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req), analysisStatus: 'draft' }, { $set: { summary: clean(req.body.summary) } }, { new: true });
    if (!call)
        return fail(res, 409, 'Only an analysis draft can be edited.');
    await audit(req.user._id, 'call.summary_edited', 'Call', call._id);
    res.json(call);
}));
app.patch('/api/calls/:id/proposed-tasks/:proposalId', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    if (!parseId(req.params.id) || !parseId(req.params.proposalId))
        return fail(res, 400, 'Invalid call or action identifier.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req), analysisStatus: 'draft' });
    if (!call)
        return fail(res, 404, 'Unreviewed call analysis was not found.');
    const proposal = call.proposedTasks.id(req.params.proposalId);
    if (!proposal)
        return fail(res, 404, 'Proposed action was not found.');
    const action = req.body?.action;
    if (action === 'edit') {
        if (proposal.reviewStatus !== 'Pending Approval')
            return fail(res, 409, 'Only an unreviewed action can be edited.');
        const description = clean(req.body?.description);
        if (!description || description.length > 500)
            return fail(res, 400, 'Enter an action description under 500 characters.');
        if (req.body?.responsibleRole && !responsibleRoles.includes(req.body.responsibleRole))
            return fail(res, 400, 'Unsupported responsible staff role.');
        if (req.body?.priority && !['Low', 'Medium', 'High'].includes(req.body.priority))
            return fail(res, 400, 'Unsupported action priority.');
        proposal.description = description;
        if (req.body?.responsibleRole)
            proposal.responsibleRole = req.body.responsibleRole;
        if (req.body?.priority)
            proposal.priority = req.body.priority;
        await call.save();
        await audit(req.user._id, 'call.proposed_action_edited', 'Call', call._id, { proposalId: String(proposal._id) });
        return res.json({ call });
    }
    if (!['approve', 'reject'].includes(action))
        return fail(res, 400, 'Action must be approve, edit or reject.');
    if (proposal.reviewStatus !== 'Pending Approval')
        return fail(res, 409, `This action was already ${proposal.reviewStatus.toLowerCase()}.`);
    let task = null;
    if (action === 'approve') {
        task = await Task.findOneAndUpdate({ callId: call._id, proposedTaskId: proposal._id }, { $setOnInsert: { title: proposal.description, description: proposal.description, patientId: call.patientId, callId: call._id, proposedTaskId: proposal._id, responsibleRole: proposal.responsibleRole, priority: proposal.priority, status: 'Pending', dueAt: proposal.dueAt, sourceExcerpt: proposal.sourceExcerpt, isDemo: call.isDemo, createdBy: req.user._id, history: [{ status: 'Pending', note: 'Created after staff approved this individual AI action.', by: req.user._id }] } }, { new: true, upsert: true, setDefaultsOnInsert: true });
        proposal.taskId = task._id;
        proposal.reviewStatus = 'Approved';
    }
    else
        proposal.reviewStatus = 'Rejected';
    proposal.reviewedBy = req.user._id;
    proposal.reviewedAt = new Date();
    if (call.proposedTasks.every(p => p.reviewStatus !== 'Pending Approval')) {
        call.analysisStatus = 'approved';
        call.reviewedBy = req.user._id;
        call.reviewedAt = new Date();
    }
    await call.save();
    await audit(req.user._id, `call.proposed_action_${action === 'reject' ? 'rejected' : 'approved'}`, 'Call', call._id, { proposalId: String(proposal._id), taskId: task?._id || null });
    res.json({ call, task });
}));
app.post('/api/calls/:id/approve', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid call identifier.');
    const call = await Call.findOne({ _id: req.params.id, ...modeFilter(req), analysisStatus: 'draft' });
    if (!call)
        return fail(res, 409, 'Call analysis is missing or has already been reviewed.');
    const pending = call.proposedTasks.filter(t => t.reviewStatus === 'Pending Approval');
    const tasks = await Promise.all(pending.map(async (t) => {
        const task = await Task.findOneAndUpdate({ callId: call._id, proposedTaskId: t._id }, { $setOnInsert: { title: t.description, description: t.description, patientId: call.patientId, callId: call._id, proposedTaskId: t._id, responsibleRole: t.responsibleRole, priority: t.priority, status: 'Pending', dueAt: t.dueAt, sourceExcerpt: t.sourceExcerpt, isDemo: call.isDemo, createdBy: req.user._id, history: [{ status: 'Pending', note: 'Created after staff approved this AI action.', by: req.user._id }] } }, { new: true, upsert: true, setDefaultsOnInsert: true });
        t.taskId = task._id;
        t.reviewStatus = 'Approved';
        t.reviewedBy = req.user._id;
        t.reviewedAt = new Date();
        return task;
    }));
    call.analysisStatus = 'approved';
    call.reviewedBy = req.user._id;
    call.reviewedAt = new Date();
    await call.save();
    await audit(req.user._id, 'call.analysis_approved', 'Call', call._id, { tasksCreated: tasks.length });
    res.json({ call, tasks });
}));
app.get('/api/tasks', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:read'))
        return;
    const filter = { ...modeFilter(req), ...(req.query.status ? { status: clean(req.query.status) } : {}), ...(req.query.departmentId && parseId(req.query.departmentId) ? { departmentId: req.query.departmentId } : {}) };
    res.json(await Task.find(filter).sort({ createdAt: -1 }).limit(300).populate('patientId', 'displayName externalId').populate('departmentId', 'name').populate('assignedTo', 'name').populate('callId', 'callerLabel status').lean());
}));
app.post('/api/tasks', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    const title = clean(req.body?.title);
    if (!title)
        return fail(res, 400, 'Task title is required.');
    for (const [field, Model, key] of [['patientId', Patient, 'patientId'], ['callId', Call, 'callId'], ['departmentId', Department, 'departmentId']]) {
        if (req.body?.[key]) {
            if (!parseId(req.body[key]))
                return fail(res, 400, `Invalid ${key}.`);
            const record = await Model.findOne({ _id: req.body[key], isDemo: isDemoMode(req) });
            if (!record)
                return fail(res, 404, `${key} not found in the selected data mode.`);
        }
    }
    if (req.body?.assignedTo) {
        if (!parseId(req.body.assignedTo) || !await User.exists({ _id: req.body.assignedTo, active: true }))
            return fail(res, 404, 'Assigned staff account was not found.');
    }
    const task = await Task.create({ title, description: clean(req.body?.description), patientId: req.body?.patientId || null, callId: req.body?.callId || null, departmentId: req.body?.departmentId || null, responsibleRole: responsibleRoles.includes(req.body?.responsibleRole) ? req.body.responsibleRole : 'Patient Support Staff', assignedTo: req.body?.assignedTo || null, priority: ['Low', 'Medium', 'High'].includes(req.body?.priority) ? req.body.priority : 'Medium', status: 'Pending Confirmation', dueAt: req.body?.dueAt ? new Date(req.body.dueAt) : null, sourceExcerpt: clean(req.body?.sourceExcerpt), isDemo: isDemoMode(req), createdBy: req.user._id, history: [{ status: 'Pending Confirmation', note: 'Created for staff confirmation.', by: req.user._id }] });
    await audit(req.user._id, 'task.created', 'Task', task._id);
    res.status(201).json(task);
}));
app.patch('/api/tasks/:id', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid task identifier.');
    const task = await Task.findOne({ _id: req.params.id, ...modeFilter(req) });
    if (!task)
        return fail(res, 404, 'Task not found.');
    if (req.body?.title !== undefined) {
        const title = clean(req.body.title);
        if (!title)
            return fail(res, 400, 'Task title cannot be blank.');
        task.title = title;
    }
    if (req.body?.departmentId !== undefined) {
        if (req.body.departmentId && !parseId(req.body.departmentId))
            return fail(res, 400, 'Invalid department identifier.');
        task.departmentId = req.body.departmentId || null;
    }
    if (req.body?.responsibleRole !== undefined) {
        if (!responsibleRoles.includes(req.body.responsibleRole))
            return fail(res, 400, 'Unsupported responsible staff role.');
        task.responsibleRole = req.body.responsibleRole;
    }
    if (req.body?.assignedTo !== undefined) {
        if (req.body.assignedTo && !parseId(req.body.assignedTo))
            return fail(res, 400, 'Invalid staff identifier.');
        task.assignedTo = req.body.assignedTo || null;
    }
    if (req.body?.dueAt !== undefined) {
        if (req.body.dueAt && Number.isNaN(Date.parse(req.body.dueAt)))
            return fail(res, 400, 'Invalid due date.');
        task.dueAt = req.body.dueAt || null;
    }
    if (req.body?.internalNotes !== undefined)
        task.internalNotes = clean(req.body.internalNotes).slice(0, 2000);
    if (req.body?.status !== undefined) {
        if (!validStatusTransition(task.status, req.body.status))
            return fail(res, 409, `Cannot move task from ${task.status} to ${req.body.status}.`);
        if (['Completed', 'Escalated'].includes(req.body.status) && req.user.role === 'staff' && task.assignedTo && String(task.assignedTo) !== String(req.user._id))
            return fail(res, 403, 'Only the assigned staff member or a coordinator can update this task.');
        task.status = req.body.status;
        task.history.push({ status: req.body.status, note: clean(req.body.note) || 'Status updated by staff.', by: req.user._id });
        if (req.body.status === 'Completed')
            task.completionDetails = clean(req.body.completionDetails).slice(0, 1000);
    }
    await task.save();
    await audit(req.user._id, 'task.updated', 'Task', task._id, { status: task.status });
    res.json(await Task.findById(task._id).populate('departmentId', 'name').populate('patientId', 'displayName externalId').lean());
}));
app.get('/api/appointments', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'appointment:read'))
        return;
    res.json(await Appointment.find(modeFilter(req)).sort({ scheduledAt: 1 }).limit(300).populate('patientId', 'displayName externalId').populate('departmentId', 'name').lean());
}));
app.post('/api/appointments', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'appointment:write'))
        return;
    if (!parseId(req.body?.patientId) || !parseId(req.body?.departmentId) || Number.isNaN(Date.parse(req.body?.scheduledAt)))
        return fail(res, 400, 'Select a patient, department, and valid appointment time.');
    const [patient, department] = await Promise.all([Patient.findOne({ _id: req.body.patientId, ...modeFilter(req) }), Department.findOne({ _id: req.body.departmentId, isDemo: isDemoMode(req) })]);
    if (!patient || !department)
        return fail(res, 404, 'Patient or department not found in the selected data mode.');
    const appointment = await Appointment.create({ patientId: patient._id, departmentId: department._id, providerName: clean(req.body.providerName), scheduledAt: new Date(req.body.scheduledAt), room: clean(req.body.room), confirmedByStaff: req.body.confirmedByStaff === true, isDemo: isDemoMode(req), createdBy: req.user._id });
    await audit(req.user._id, 'appointment.created', 'Appointment', appointment._id);
    res.status(201).json(appointment);
}));
app.patch('/api/appointments/:id/confirm', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'appointment:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid appointment identifier.');
    const appointment = await Appointment.findOne({ _id: req.params.id, ...modeFilter(req) });
    if (!appointment)
        return fail(res, 404, 'Appointment not found.');
    if (req.body?.confirmed === true && appointment.requestStatus !== 'cancellation_requested') {
        const proposedAt = appointment.requestStatus === 'reschedule_requested' ? appointment.requestedScheduledAt : appointment.scheduledAt;
        if (!proposedAt || Number.isNaN(new Date(proposedAt).getTime()))
            return fail(res, 400, 'Appointment time is invalid.');
        const start = new Date(proposedAt);
        const conflictCriteria = [{ patientId: appointment.patientId }];
        if (appointment.providerName)
            conflictCriteria.push({ providerName: appointment.providerName, departmentId: appointment.departmentId });
        const conflict = await Appointment.exists({ _id: { $ne: appointment._id }, isDemo: appointment.isDemo, status: 'Scheduled', confirmedByStaff: true, scheduledAt: { $gt: new Date(start.getTime() - 30 * 60000), $lt: new Date(start.getTime() + 30 * 60000) }, $or: conflictCriteria });
        if (conflict)
            return fail(res, 409, 'This time conflicts with another confirmed appointment for the patient or provider.');
    }
    if (req.body?.confirmed === true && appointment.requestStatus === 'cancellation_requested') {
        appointment.status = 'Cancelled';
        appointment.confirmedByStaff = false;
        appointment.requestStatus = 'confirmed';
    }
    else if (req.body?.confirmed === true && appointment.requestStatus === 'reschedule_requested') {
        if (!appointment.requestedScheduledAt)
            return fail(res, 409, 'No requested reschedule time is available.');
        appointment.scheduledAt = appointment.requestedScheduledAt;
        appointment.requestedScheduledAt = null;
    }
    if (req.body?.confirmed === true) {
        appointment.confirmedByStaff = true;
        appointment.requestStatus = 'confirmed';
    }
    else if (['reschedule_requested', 'cancellation_requested'].includes(appointment.requestStatus)) {
        appointment.requestedScheduledAt = null;
        appointment.requestStatus = 'rejected';
    }
    else {
        appointment.confirmedByStaff = false;
        appointment.requestStatus = appointment.requestStatus === 'none' ? 'none' : 'rejected';
    }
    await appointment.save();
    await audit(req.user._id, 'appointment.verification_changed', 'Appointment', appointment._id, { confirmedByStaff: appointment.confirmedByStaff });
    res.json(appointment);
}));
app.get('/api/messages', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'message:draft'))
        return;
    res.json(await PatientMessage.find(modeFilter(req)).sort({ createdAt: -1 }).limit(300).populate('patientId', 'displayName externalId').populate('appointmentId', 'scheduledAt confirmedByStaff').lean());
}));
app.post('/api/messages', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'message:draft'))
        return;
    const body = clean(req.body?.body), channel = ['Patient portal', 'SMS', 'Email'].includes(req.body?.channel) ? req.body.channel : 'Patient portal';
    if (!parseId(req.body?.patientId) || !body || body.length > 4000)
        return fail(res, 400, 'Choose a patient and enter a message (4,000 characters maximum).');
    const patient = await Patient.findOne({ _id: req.body.patientId, ...modeFilter(req) });
    if (!patient)
        return fail(res, 404, 'Patient not found in the selected data mode.');
    let appointmentId = null;
    if (req.body?.appointmentId) {
        if (!parseId(req.body.appointmentId) || !await Appointment.exists({ _id: req.body.appointmentId, patientId: patient._id, confirmedByStaff: true, ...modeFilter(req) }))
            return fail(res, 400, 'Messages may only reference this patient’s staff-confirmed appointment.');
        appointmentId = req.body.appointmentId;
    }
    const message = await PatientMessage.create({ patientId: patient._id, appointmentId, body, channel, isDemo: isDemoMode(req), createdBy: req.user._id });
    await audit(req.user._id, 'patient_message.created', 'PatientMessage', message._id, { channel });
    res.status(201).json(message);
}));
app.patch('/api/messages/:id/review', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'message:draft'))
        return;
    if (!parseId(req.params.id) || !['approve', 'reject'].includes(req.body?.action))
        return fail(res, 400, 'Choose approve or reject for a valid message.');
    const message = await PatientMessage.findOne({ _id: req.params.id, ...modeFilter(req), status: 'Pending Approval' });
    if (!message)
        return fail(res, 404, 'Pending message was not found.');
    message.status = req.body.action === 'approve' ? 'Approved' : 'Rejected';
    message.reviewedBy = req.user._id;
    message.reviewedAt = new Date();
    message.deliveryStatus = message.status === 'Approved' ? (message.channel === 'Patient portal' ? 'Visible in patient portal' : 'Provider not configured') : 'Not sent';
    await message.save();
    await audit(req.user._id, `patient_message.${req.body.action}d`, 'PatientMessage', message._id, { channel: message.channel, deliveryStatus: message.deliveryStatus });
    res.json(message);
}));
app.get('/api/documents', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'document:read'))
        return;
    res.json(await DocumentChecklist.find(modeFilter(req)).sort({ createdAt: -1 }).limit(300).populate('patientId', 'displayName externalId').lean());
}));
app.post('/api/documents', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'document:write'))
        return;
    const name = clean(req.body?.name);
    if (!name)
        return fail(res, 400, 'Checklist item name is required.');
    const doc = await DocumentChecklist.create({ name, patientId: req.body?.patientId || null, appointmentId: req.body?.appointmentId || null, status: 'Required', isDemo: isDemoMode(req), createdBy: req.user._id });
    await audit(req.user._id, 'document_checklist.created', 'DocumentChecklist', doc._id);
    res.status(201).json(doc);
}));
app.patch('/api/documents/:id', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'document:write'))
        return;
    if (!parseId(req.params.id) || !['Required', 'Received', 'Not applicable'].includes(req.body?.status))
        return fail(res, 400, 'Valid document ID and checklist status are required.');
    const doc = await DocumentChecklist.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req) }, { $set: { status: req.body.status, verifiedBy: req.body.status === 'Received' ? req.user._id : null, verifiedAt: req.body.status === 'Received' ? new Date() : null } }, { new: true });
    if (!doc)
        return fail(res, 404, 'Checklist item not found.');
    await audit(req.user._id, 'document_checklist.updated', 'DocumentChecklist', doc._id, { status: doc.status });
    res.json(doc);
}));
app.get('/api/followups', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:read'))
        return;
    res.json(await FollowUp.find(modeFilter(req)).sort({ dueAt: 1 }).limit(300).populate('taskId').populate('patientId', 'displayName externalId').lean());
}));
app.post('/api/tasks/:id/followups', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid task identifier.');
    const task = await Task.findOne({ _id: req.params.id, ...modeFilter(req) });
    if (!task)
        return fail(res, 404, 'Task not found.');
    const follow = await FollowUp.create({ taskId: task._id, patientId: task.patientId, dueAt: req.body?.dueAt ? new Date(req.body.dueAt) : null, note: clean(req.body?.note), isDemo: task.isDemo, createdBy: req.user._id });
    await audit(req.user._id, 'followup.created', 'FollowUp', follow._id);
    res.status(201).json(follow);
}));
app.patch('/api/followups/:id', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'task:write'))
        return;
    if (!parseId(req.params.id) || !['Pending', 'Completed', 'Cancelled'].includes(req.body?.status))
        return fail(res, 400, 'Valid follow-up identifier and status are required.');
    const follow = await FollowUp.findOneAndUpdate({ _id: req.params.id, ...modeFilter(req) }, { $set: { status: req.body.status, ...(req.body.note !== undefined ? { note: clean(req.body.note) } : {}) } }, { new: true });
    if (!follow)
        return fail(res, 404, 'Follow-up record not found.');
    await audit(req.user._id, 'followup.updated', 'FollowUp', follow._id, { status: follow.status });
    res.json(follow);
}));
const operationalModules = {
    admissions: { Model: Admission, read: 'admission:read', write: 'admission:write', label: 'Admission', patient: true, department: true, mutable: ['plannedAt', 'admissionType', 'requiredDocuments', 'insuranceStatus', 'assignedTo'], populate: ['patientId', 'departmentId', 'assignedTo'] },
    discharges: { Model: Discharge, read: 'discharge:read', write: 'discharge:write', label: 'Discharge', patient: true, department: true, mutable: ['admissionId', 'plannedAt', 'actualAt', 'requiredDocuments', 'billingClearance', 'insuranceDocuments', 'clinicalAuthorization', 'adminClearance', 'followUpRequired'], populate: ['patientId', 'departmentId'] },
    insurance: { Model: InsuranceCase, read: 'insurance:read', write: 'insurance:write', label: 'InsuranceCase', patient: true, mutable: ['provider', 'claimReference', 'relatedType', 'relatedId', 'requiredDocuments', 'submittedDocuments', 'assignedTo'], populate: ['patientId', 'assignedTo'] },
    billing: { Model: BillingRecord, read: 'billing:read', write: 'billing:write', label: 'BillingRecord', patient: true, mutable: ['invoiceReference', 'amount', 'currency', 'relatedType', 'relatedId', 'enquiry', 'assignedTo'], populate: ['patientId', 'assignedTo'] },
    'medical-records': { Model: MedicalRecord, read: 'medical-record:read', write: 'medical-record:write', label: 'MedicalRecord', patient: true, department: false, mutable: ['documentReference', 'documentType', 'relatedType', 'relatedId', 'departmentId', 'preparationStatus', 'approvalStatus', 'releaseStatus', 'deliveryStatus', 'assignedTo'], populate: ['patientId', 'departmentId', 'assignedTo'] }
};
async function validateOperationReferences(moduleName, payload, mode) {
    if (payload.departmentId && (!parseId(payload.departmentId) || !await Department.exists({ _id: payload.departmentId, isDemo: mode.isDemo })))
        return 'Department is not part of this hospital and data mode.';
    if (payload.assignedTo && (!parseId(payload.assignedTo) || !await User.exists({ _id: payload.assignedTo, active: true })))
        return 'Assigned staff member is not active in this hospital.';
    if (payload.admissionId && (!parseId(payload.admissionId) || !await Admission.exists({ _id: payload.admissionId, ...mode })))
        return 'Related admission is not in this hospital and data mode.';
    if (payload.relatedId) {
        const Related = { Appointment, Admission, Discharge }[payload.relatedType];
        if (!parseId(payload.relatedId) || !Related || !await Related.exists({ _id: payload.relatedId, ...mode }))
            return 'Related record is not in this hospital and data mode.';
    }
    return null;
}
app.get('/api/operations/:module', asyncRoute(async (req, res) => {
    const config = operationalModules[req.params.module];
    if (!config)
        return fail(res, 404, 'Unknown operations module.');
    if (!allowed(req, res, config.read))
        return;
    res.json(await config.Model.find({ ...modeFilter(req) }).sort({ createdAt: -1 }).limit(500).populate(config.populate).lean());
}));
app.post('/api/operations/:module', asyncRoute(async (req, res) => {
    const config = operationalModules[req.params.module];
    if (!config)
        return fail(res, 404, 'Unknown operations module.');
    if (!allowed(req, res, config.write))
        return;
    if (!parseId(req.body?.patientId))
        return fail(res, 400, 'Select a patient from this hospital.');
    const patient = await Patient.findOne({ _id: req.body.patientId, ...modeFilter(req) });
    if (!patient)
        return fail(res, 404, 'Patient not found in the selected hospital and data mode.');
    let department = null;
    if (config.department) {
        if (!parseId(req.body?.departmentId))
            return fail(res, 400, 'Select a department from this hospital.');
        department = await Department.findOne({ _id: req.body.departmentId, isDemo: isDemoMode(req) });
        if (!department)
            return fail(res, 404, 'Department not found in the selected hospital and data mode.');
    }
    const payload = { patientId: patient._id, ...(department ? { departmentId: department._id } : {}), isDemo: isDemoMode(req), createdBy: req.user._id };
    for (const field of config.mutable)
        if (req.body[field] !== undefined)
            payload[field] = req.body[field];
    const referenceError = await validateOperationReferences(req.params.module, payload, modeFilter(req));
    if (referenceError)
        return fail(res, 400, referenceError);
    if (req.params.module === 'billing' && req.body.amount !== undefined && (!Number.isFinite(Number(req.body.amount)) || Number(req.body.amount) < 0))
        return fail(res, 400, 'Amount must be a verified non-negative number.');
    if (req.params.module === 'billing' && !payload.currency)
        payload.currency = req.hospital.currency || 'INR';
    if (req.params.module === 'medical-records' && !clean(payload.documentType))
        return fail(res, 400, 'Document type is required.');
    const initialStatus = config.Model.schema.path('status')?.defaultValue || 'Requested';
    if (config.Model.schema.path('history'))
        payload.history = [{ status: initialStatus, note: 'Record created by authorized staff.', by: req.user._id }];
    const record = await config.Model.create(payload);
    await audit(req.user._id, `${req.params.module}.created`, config.label, record._id);
    res.status(201).json(record);
}));
app.patch('/api/operations/:module/:id', asyncRoute(async (req, res) => {
    const config = operationalModules[req.params.module];
    if (!config)
        return fail(res, 404, 'Unknown operations module.');
    if (!allowed(req, res, config.write))
        return;
    if (!parseId(req.params.id))
        return fail(res, 400, 'Invalid record identifier.');
    const record = await config.Model.findOne({ _id: req.params.id, ...modeFilter(req) });
    if (!record)
        return fail(res, 404, 'Record not found in this hospital and data mode.');
    const statusField = req.params.module === 'billing' ? 'paymentStatus' : req.params.module === 'medical-records' ? null : 'status';
    const changes = [];
    for (const field of config.mutable)
        if (req.body[field] !== undefined) {
            record[field] = req.body[field];
            changes.push(field);
        }
    const referenceError = await validateOperationReferences(req.params.module, record, modeFilter(req));
    if (referenceError)
        return fail(res, 400, referenceError);
    const statusFields = statusField ? [statusField] : req.params.module === 'medical-records' ? ['preparationStatus', 'approvalStatus', 'releaseStatus', 'deliveryStatus'] : [];
    for (const field of statusFields)
        if (req.body[field] !== undefined) {
            const values = config.Model.schema.path(field)?.enumValues || [];
            if (!values.includes(req.body[field]))
                return fail(res, 400, `Unsupported ${field} value.`);
            record[field] = req.body[field];
            changes.push(field);
            if (record.history)
                record.history.push({ status: req.body[field], note: clean(req.body.note) || `${field} updated by staff.`, by: req.user._id });
        }
    if (req.params.module === 'admissions' && req.body.status === 'Verified' && req.user.role === 'staff')
        return fail(res, 403, 'Only a hospital coordinator or administrator can verify an admission.');
    if (req.params.module === 'discharges' && req.body.status === 'Completed' && (record.clinicalAuthorization !== 'Authorized' || !(req.body.actualAt || record.actualAt)))
        return fail(res, 409, 'A discharge cannot be marked completed without separately recorded clinical authorization and an actual discharge time.');
    if (!changes.length)
        return fail(res, 400, 'No supported fields were provided.');
    await record.save();
    await audit(req.user._id, `${req.params.module}.updated`, config.label, record._id, { changedFields: changes });
    res.json(record);
}));
app.get('/api/analytics', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'analytics:read'))
        return;
    const match = modeFilter(req);
    const [callGroups, taskGroups, monthly] = await Promise.all([
        Call.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, durationMs: { $sum: { $cond: [{ $and: ['$startedAt', '$endedAt'] }, { $subtract: ['$endedAt', '$startedAt'] }, 0] } } } }]),
        Task.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Call.aggregate([{ $match: { ...match, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, calls: { $sum: 1 } } }, { $sort: { _id: 1 } }])
    ]);
    const calls = Object.fromEntries(callGroups.map(x => [x._id, x.count]));
    const tasks = Object.fromEntries(taskGroups.map(x => [x._id, x.count]));
    const totalCalls = Object.values(calls).reduce((a, b) => a + b, 0);
    const completed = calls.completed || 0;
    const durations = callGroups.reduce((sum, row) => sum + row.durationMs, 0);
    const resolvedTasks = tasks.Completed || 0;
    const totalTasks = Object.values(tasks).reduce((a, b) => a + b, 0);
    res.json({ mode: isDemoMode(req) ? 'demo' : 'live', source: 'mongodb', totalCalls, calls, tasks, averageDurationSeconds: completed ? Math.round(durations / completed / 1000) : null, callResolutionRate: totalCalls ? Math.round(completed / totalCalls * 100) : null, taskCompletionRate: totalTasks ? Math.round(resolvedTasks / totalTasks * 100) : null, dailyCallVolume: monthly.map(x => ({ date: x._id, calls: x.calls })), satisfaction: null, aiAssistedResolutionRate: null, note: 'Only metrics derivable from stored records are returned. No satisfaction or AI-success results are fabricated.' });
}));
app.post('/api/communications/package-preview', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'message:draft'))
        return;
    if (!parseId(req.body?.appointmentId))
        return fail(res, 400, 'Choose an appointment record.');
    const appointment = await Appointment.findOne({ _id: req.body.appointmentId, ...modeFilter(req), confirmedByStaff: true }).populate('patientId', 'displayName').populate('departmentId', 'name');
    if (!appointment)
        return fail(res, 404, 'A staff-confirmed appointment was not found.');
    const [documents, patient] = await Promise.all([DocumentChecklist.find({ appointmentId: appointment._id, ...modeFilter(req), status: 'Required' }).select('name').lean(), Patient.findById(appointment.patientId._id).select('consentToProcessing')]);
    res.json({ channel: ['SMS', 'WhatsApp', 'Email', 'Patient portal', 'Printable'].includes(req.body.channel) ? req.body.channel : 'Patient portal', status: 'Draft · not sent', patient: appointment.patientId.displayName, appointment: { at: appointment.scheduledAt, department: appointment.departmentId.name, room: appointment.room }, requiredDocuments: documents.map(d => d.name), navigationLink: null, contact: null, note: 'Only staff-confirmed appointment data is included. No location, directions, delivery, or clinical instruction is invented.', consentToExternalProcessing: Boolean(patient?.consentToProcessing) });
}));
app.get('/api/audit', asyncRoute(async (req, res) => {
    if (!allowed(req, res, 'audit:read'))
        return;
    res.json(await AuditLog.find().sort({ at: -1 }).limit(300).populate('actorId', 'name email role').lean());
}));
app.use((error, _req, res, _next) => {
    if (error?.name === 'MulterError')
        return fail(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.message);
    if (error?.name === 'ValidationError')
        return fail(res, 400, 'Validation failed.', Object.values(error.errors).map(e => e.message));
    if (error?.code === 11000)
        return fail(res, 409, 'A record with that unique value already exists.');
    console.error('CareFlow API error:', error?.message || error);
    return fail(res, 500, 'The request could not be completed.');
});
function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function openAIChat(payload) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(`OpenAI request failed: ${clean(json.error?.message).slice(0, 250) || response.status}`);
    return json;
}
export async function connectDatabase(uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/careflow_ai') {
    await connectToCareFlowDatabase(uri);
    let defaultHospital = await Hospital.findOne({ slug: 'careflow-demo' });
    if (!defaultHospital)
        defaultHospital = await Hospital.create({ name: clean(process.env.DEFAULT_HOSPITAL_NAME) || 'CareFlow Demonstration Hospital', slug: 'careflow-demo', city: 'Mysuru', state: 'Karnataka', currency: 'INR', timeZone: 'Asia/Kolkata', status: 'active' });
    return defaultHospital;
}
export default app;
//# sourceMappingURL=app.js.map
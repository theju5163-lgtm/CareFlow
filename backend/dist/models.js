import mongoose from 'mongoose';
import { tenantPlugin } from './tenant-context.js';
const { Schema, model } = mongoose;
const opts = { timestamps: true, versionKey: false };
const roles = ['admin', 'coordinator', 'staff', 'patient', 'doctor', 'nurse', 'receptionist', 'appointment_coordinator', 'admission_coordinator', 'discharge_coordinator', 'medical_records_officer', 'insurance_officer', 'billing_officer', 'patient_relations_officer', 'supervisor', 'auditor'];
const hospitalSchema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 180 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    address: { type: String, trim: true, maxlength: 500, default: '' },
    city: { type: String, trim: true, maxlength: 100, default: '' },
    state: { type: String, trim: true, maxlength: 100, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },
    phoneVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    logoUrl: { type: String, trim: true, maxlength: 500, default: '' },
    currency: { type: String, enum: ['INR', 'USD'], default: 'INR' },
    timeZone: { type: String, default: 'Asia/Kolkata' },
    status: { type: String, enum: ['pending_verification', 'setup', 'active', 'suspended'], default: 'setup' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, opts);
const hospitalMembershipSchema = new Schema({
    hospitalId: { type: Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: roles, default: 'staff' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    employeeId: { type: String, trim: true, uppercase: true, maxlength: 80, default: '' },
    jobTitle: { type: String, trim: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    active: { type: Boolean, default: true }
}, opts);
hospitalMembershipSchema.index({ hospitalId: 1, userId: 1 }, { unique: true });
hospitalMembershipSchema.index({ hospitalId: 1, employeeId: 1 }, { unique: true, partialFilterExpression: { employeeId: { $type: 'string', $gt: '' } } });
const userSchema = new Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: roles, default: 'staff' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    hospitalIds: [{ type: Schema.Types.ObjectId, ref: 'Hospital' }],
    active: { type: Boolean, default: true }
}, opts);
userSchema.plugin(tenantPlugin, { membership: true });
const patientSchema = new Schema({
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    externalId: { type: String, trim: true, maxlength: 80, default: '' },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, default: '' },
    consentToProcessing: { type: Boolean, default: false },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
patientSchema.plugin(tenantPlugin);
patientSchema.index({ displayName: 'text', externalId: 'text' });
const departmentSchema = new Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, trim: true, uppercase: true, maxlength: 16, default: '' },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    managerStaffId: { type: Schema.Types.ObjectId, ref: 'HospitalMembership', default: null },
    active: { type: Boolean, default: true },
    isDemo: { type: Boolean, default: false }
}, opts);
departmentSchema.plugin(tenantPlugin);
departmentSchema.index({ name: 1, isDemo: 1, hospitalId: 1 }, { unique: true });
departmentSchema.index({ code: 1, isDemo: 1, hospitalId: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string', $gt: '' } } });
const transcriptSegmentSchema = new Schema({
    speaker: { type: String, enum: ['Doctor', 'Nurse', 'Patient', 'Caregiver', 'Staff', 'Unknown'], default: 'Unknown' },
    text: { type: String, required: true, maxlength: 8000 },
    originalText: { type: String, maxlength: 8000, default: null },
    editedAt: { type: Date, default: null },
    at: { type: Date, default: Date.now },
    confidence: { type: Number, min: 0, max: 1, default: null },
    uncertain: { type: Boolean, default: false },
    editedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: true });
const proposedTaskSchema = new Schema({
    description: { type: String, required: true, maxlength: 500 },
    responsibleRole: { type: String, enum: ['Appointment Staff', 'Patient Support Staff', 'Billing Staff', 'Clinical Review Staff', 'Administrator'], default: 'Patient Support Staff' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
    sourceExcerpt: { type: String, maxlength: 1000, default: '' },
    dueAt: { type: Date, default: null },
    reviewStatus: { type: String, enum: ['Pending Approval', 'Approved', 'Rejected'], default: 'Pending Approval' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null }
}, { _id: true });
const callSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    callerLabel: { type: String, trim: true, maxlength: 120, default: 'Unverified caller' },
    direction: { type: String, enum: ['incoming', 'outgoing'], default: 'incoming' },
    status: { type: String, enum: ['active', 'completed', 'missed', 'abandoned'], default: 'active' },
    telephonyProvider: { type: String, enum: ['none', 'exotel'], default: 'none' },
    providerCallId: { type: String, trim: true, maxlength: 120, default: '', index: true },
    providerStatus: { type: String, trim: true, maxlength: 80, default: '' },
    callState: { type: String, enum: ['Initiating', 'Ringing', 'Connected', 'In Progress', 'Completed', 'Busy', 'No Answer', 'Failed'], default: 'Initiating' },
    connectedAt: { type: Date, default: null },
    durationSeconds: { type: Number, min: 0, default: null },
    clientRequestId: { type: String, trim: true, maxlength: 80, default: null },
    callConsentConfirmedAt: { type: Date, default: null },
    recordingConsentConfirmedAt: { type: Date, default: null },
    providerRecordingUrl: { type: String, maxlength: 2000, select: false, default: null },
    patientPhoneLast4: { type: String, trim: true, maxlength: 4, default: '' },
    agentPhoneLast4: { type: String, trim: true, maxlength: 4, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: '' },
    language: { type: String, enum: ['Kannada', 'English', 'Hindi', 'Tamil', 'Telugu', 'Unknown'], default: 'Unknown' },
    verificationStatus: { type: String, enum: ['unverified', 'verified'], default: 'unverified' },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    transcript: { type: [transcriptSegmentSchema], default: [] },
    summary: { type: String, maxlength: 5000, default: '' },
    patientRequests: [{ type: String, maxlength: 500 }],
    proposedTasks: { type: [proposedTaskSchema], default: [] },
    analysisStatus: { type: String, enum: ['not_started', 'draft', 'approved'], default: 'not_started' },
    analysisProvider: { type: String, enum: ['none', 'openai', 'staff'], default: 'none' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    recordingMetadata: { mimeType: String, durationSeconds: Number, stored: { type: Boolean, default: false } },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
callSchema.plugin(tenantPlugin);
callSchema.index({ callerLabel: 'text', summary: 'text', category: 'text' });
callSchema.index({ hospitalId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
const taskSchema = new Schema({
    title: { type: String, required: true, trim: true, maxlength: 240 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    callId: { type: Schema.Types.ObjectId, ref: 'Call', default: null },
    proposedTaskId: { type: Schema.Types.ObjectId, default: null },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    responsibleRole: { type: String, enum: ['Appointment Staff', 'Patient Support Staff', 'Billing Staff', 'Clinical Review Staff', 'Administrator'], default: 'Patient Support Staff' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    priority: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
    status: { type: String, enum: ['Draft', 'Pending Confirmation', 'Pending', 'In Progress', 'Completed', 'Cancelled', 'Escalated'], default: 'Pending Confirmation' },
    dueAt: { type: Date, default: null },
    sourceExcerpt: { type: String, trim: true, maxlength: 1000, default: '' },
    internalNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    completionDetails: { type: String, trim: true, maxlength: 1000, default: '' },
    history: [{ status: String, note: String, at: { type: Date, default: Date.now }, by: { type: Schema.Types.ObjectId, ref: 'User' } }],
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
taskSchema.plugin(tenantPlugin);
taskSchema.index({ status: 1, departmentId: 1, dueAt: 1 });
taskSchema.index({ hospitalId: 1, callId: 1, proposedTaskId: 1 }, { unique: true, partialFilterExpression: { proposedTaskId: { $type: 'objectId' } } });
const appointmentSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    providerName: { type: String, trim: true, maxlength: 120, default: '' },
    scheduledAt: { type: Date, required: true },
    room: { type: String, trim: true, maxlength: 100, default: '' },
    confirmedByStaff: { type: Boolean, default: false },
    requestStatus: { type: String, enum: ['none', 'requested', 'reschedule_requested', 'cancellation_requested', 'confirmed', 'rejected'], default: 'none' },
    requestedScheduledAt: { type: Date, default: null },
    patientRequestNote: { type: String, trim: true, maxlength: 500, default: '' },
    requestedAt: { type: Date, default: null },
    status: { type: String, enum: ['Scheduled', 'Completed', 'Cancelled'], default: 'Scheduled' },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
appointmentSchema.plugin(tenantPlugin);
const messageSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    status: { type: String, enum: ['Pending Approval', 'Approved', 'Rejected'], default: 'Pending Approval' },
    channel: { type: String, enum: ['Patient portal', 'SMS', 'Email'], default: 'Patient portal' },
    deliveryStatus: { type: String, enum: ['Not sent', 'Visible in patient portal', 'Provider not configured'], default: 'Not sent' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false }
}, opts);
messageSchema.plugin(tenantPlugin);
const historyRows = [{ status: String, note: String, at: { type: Date, default: Date.now }, by: { type: Schema.Types.ObjectId, ref: 'User' } }];
const admissionSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true }, departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    plannedAt: { type: Date, default: null }, admissionType: { type: String, trim: true, maxlength: 100, default: '' },
    requiredDocuments: [{ type: String, trim: true, maxlength: 200 }], insuranceStatus: { type: String, enum: ['Unknown', 'Pending verification', 'Verified', 'Not applicable'], default: 'Unknown' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null }, status: { type: String, enum: ['Requested', 'Pending documentation', 'Scheduled', 'Under review', 'Verified', 'Deferred', 'Cancelled'], default: 'Requested' },
    history: historyRows, isDemo: { type: Boolean, default: false }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
admissionSchema.plugin(tenantPlugin);
const dischargeSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true }, admissionId: { type: Schema.Types.ObjectId, ref: 'Admission', default: null }, departmentId: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    plannedAt: { type: Date, default: null }, actualAt: { type: Date, default: null }, requiredDocuments: [{ type: String, trim: true, maxlength: 200 }],
    billingClearance: { type: String, enum: ['Unknown', 'Pending', 'Cleared'], default: 'Unknown' }, insuranceDocuments: { type: String, enum: ['Unknown', 'Pending', 'Complete'], default: 'Unknown' },
    clinicalAuthorization: { type: String, enum: ['Not confirmed', 'Authorized'], default: 'Not confirmed' }, adminClearance: { type: String, enum: ['Pending', 'Cleared'], default: 'Pending' },
    followUpRequired: { type: Boolean, default: false }, status: { type: String, enum: ['Planned', 'Pending documentation', 'Pending billing', 'Pending clearance', 'Ready for authorized review', 'Completed', 'Deferred', 'Cancelled'], default: 'Planned' },
    history: historyRows, isDemo: { type: Boolean, default: false }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
dischargeSchema.plugin(tenantPlugin);
const insuranceCaseSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true }, provider: { type: String, trim: true, maxlength: 160, default: '' }, claimReference: { type: String, trim: true, maxlength: 120, default: '' },
    relatedType: { type: String, enum: ['Appointment', 'Admission', 'Discharge', 'Other'], default: 'Other' }, relatedId: { type: Schema.Types.ObjectId, default: null },
    requiredDocuments: [{ type: String, trim: true, maxlength: 200 }], submittedDocuments: [{ type: String, trim: true, maxlength: 200 }], assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['Open', 'Pending documents', 'Under review', 'Submitted', 'Verified', 'Closed'], default: 'Open' }, history: historyRows,
    isDemo: { type: Boolean, default: false }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
insuranceCaseSchema.plugin(tenantPlugin);
const billingRecordSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true }, invoiceReference: { type: String, trim: true, maxlength: 120, default: '' }, amount: { type: Number, min: 0, default: null },
    currency: { type: String, enum: ['INR', 'USD'], default: 'INR' }, paymentStatus: { type: String, enum: ['Unknown', 'Pending', 'Partially paid', 'Paid', 'Disputed', 'Cancelled'], default: 'Unknown' },
    relatedType: { type: String, enum: ['Appointment', 'Admission', 'Discharge', 'Other'], default: 'Other' }, relatedId: { type: Schema.Types.ObjectId, default: null }, enquiry: { type: String, trim: true, maxlength: 1000, default: '' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null }, history: historyRows, isDemo: { type: Boolean, default: false }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
billingRecordSchema.plugin(tenantPlugin);
const medicalRecordSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true }, documentReference: { type: String, trim: true, maxlength: 120, default: '' }, documentType: { type: String, required: true, trim: true, maxlength: 160 },
    relatedType: { type: String, enum: ['Appointment', 'Admission', 'Discharge', 'Other'], default: 'Other' }, relatedId: { type: Schema.Types.ObjectId, default: null }, departmentId: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
    preparationStatus: { type: String, enum: ['Requested', 'In preparation', 'Ready for review', 'Prepared'], default: 'Requested' }, approvalStatus: { type: String, enum: ['Not reviewed', 'Pending', 'Approved', 'Rejected'], default: 'Not reviewed' },
    releaseStatus: { type: String, enum: ['Not released', 'Pending', 'Released'], default: 'Not released' }, deliveryStatus: { type: String, enum: ['Not delivered', 'Pending verification', 'Verified delivered'], default: 'Not delivered' }, requestedAt: { type: Date, default: Date.now },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null }, isDemo: { type: Boolean, default: false }, createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
medicalRecordSchema.plugin(tenantPlugin);
const documentSchema = new Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: ['Required', 'Received', 'Not applicable'], default: 'Required' },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
documentSchema.plugin(tenantPlugin);
const followUpSchema = new Schema({
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    dueAt: { type: Date, default: null },
    status: { type: String, enum: ['Pending', 'Completed', 'Cancelled'], default: 'Pending' },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    isDemo: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, opts);
followUpSchema.plugin(tenantPlugin);
const auditSchema = new Schema({
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true },
    recordType: { type: String, required: true },
    recordId: { type: String, default: '' },
    details: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now }
}, { versionKey: false });
auditSchema.plugin(tenantPlugin);
export const Hospital = model('Hospital', hospitalSchema);
export const HospitalMembership = model('HospitalMembership', hospitalMembershipSchema);
export const User = model('User', userSchema);
export const Patient = model('Patient', patientSchema);
export const Department = model('Department', departmentSchema);
export const Call = model('Call', callSchema);
export const Task = model('Task', taskSchema);
export const Appointment = model('Appointment', appointmentSchema);
export const PatientMessage = model('PatientMessage', messageSchema);
export const Admission = model('Admission', admissionSchema);
export const Discharge = model('Discharge', dischargeSchema);
export const InsuranceCase = model('InsuranceCase', insuranceCaseSchema);
export const BillingRecord = model('BillingRecord', billingRecordSchema);
export const MedicalRecord = model('MedicalRecord', medicalRecordSchema);
export const DocumentChecklist = model('DocumentChecklist', documentSchema);
export const FollowUp = model('FollowUp', followUpSchema);
export const AuditLog = model('AuditLog', auditSchema);
//# sourceMappingURL=models.js.map
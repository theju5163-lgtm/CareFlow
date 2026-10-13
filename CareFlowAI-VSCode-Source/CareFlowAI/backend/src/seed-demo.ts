// @ts-nocheck
import 'dotenv/config';
import mongoose from 'mongoose';
import { User, Patient, Department, Call, Task, Appointment, DocumentChecklist } from './models.js';
import { connectDatabase } from './app.js';
import { runInHospital } from './tenant-context.js';

try {
  await connectDatabase();
  const admin = await User.findOne({ role: 'admin', active: true });
  if (!admin) throw new Error('Create the administrator first with `npm run admin:bootstrap` from the project root.');
  if (!admin.hospitalId) throw new Error('Administrator is not assigned to a hospital workspace.');
  // Every synthetic record is created inside this user's tenant context.
  await runInHospital(String(admin.hospitalId), async () => {
  const definitions = [
    ['Cardiology', 'Sample cardiology department'], ['Scheduling', 'Appointment coordination'],
    ['Patient Support', 'Directions and arrival support'], ['Front Desk', 'Registration and document checklists'], ['Billing', 'Administrative billing inquiries']
  ];
  const departments = {};
  for (const [name, description] of definitions) departments[name] = await Department.findOneAndUpdate({ name, isDemo: true }, { $setOnInsert: { name, description, isDemo: true } }, { upsert: true, new: true });
  const ramesh = await Patient.findOneAndUpdate({ externalId: 'DEMO-P-10245', isDemo: true }, { $setOnInsert: { displayName: 'Ramesh Kumar', externalId: 'DEMO-P-10245', consentToProcessing: false, isDemo: true, createdBy: admin._id } }, { upsert: true, new: true });
  const meera = await Patient.findOneAndUpdate({ externalId: 'DEMO-P-10382', isDemo: true }, { $setOnInsert: { displayName: 'Meera Nair', externalId: 'DEMO-P-10382', consentToProcessing: false, isDemo: true, createdBy: admin._id } }, { upsert: true, new: true });
  let call = await Call.findOne({ callerLabel: 'Ramesh Kumar', isDemo: true });
  if (!call) call = await Call.create({ callerLabel: 'Ramesh Kumar', patientId: ramesh._id, direction: 'incoming', status: 'completed', category: 'Appointment information', language: 'English', verificationStatus: 'unverified', isDemo: true, createdBy: admin._id, startedAt: new Date(Date.now() - 9 * 60000), endedAt: new Date(Date.now() - 5 * 60000), transcript: [{ speaker: 'Patient', text: 'I have a cardiology appointment tomorrow. Where should I go, and what documents should I bring?' }, { speaker: 'Staff', text: 'I can help share the appointment details and hospital directions.' }], summary: 'Synthetic demonstration call. Caller requests appointment details, arrival directions, and information about required documents.', patientRequests: ['Appointment details', 'Hospital navigation', 'Required document checklist'], analysisStatus: 'draft', analysisProvider: 'staff', proposedTasks: [{ description: 'Share appointment details after staff verification', departmentId: departments.Scheduling._id, priority: 'Medium', sourceExcerpt: 'I have a cardiology appointment tomorrow.' }, { description: 'Share hospital navigation information', departmentId: departments['Patient Support']._id, priority: 'Low', sourceExcerpt: 'Where should I go?' }, { description: 'Confirm required document checklist', departmentId: departments['Front Desk']._id, priority: 'Low', sourceExcerpt: 'What documents should I bring?' }] });
  let secondCall = await Call.findOne({ callerLabel: 'Meera Nair', isDemo: true });
  if (!secondCall) secondCall = await Call.create({ callerLabel: 'Meera Nair', patientId: meera._id, direction: 'incoming', status: 'completed', category: 'Document inquiry', language: 'English', verificationStatus: 'unverified', isDemo: true, createdBy: admin._id, startedAt: new Date(Date.now() - 75 * 60000), endedAt: new Date(Date.now() - 69 * 60000), transcript: [{ speaker: 'Patient', text: 'Could you tell me which documents I should bring for my appointment?' }], summary: 'Synthetic sample. Caller asks for a document checklist; no documents are specified in the transcript.', patientRequests: ['Document checklist'], analysisStatus: 'not_started' });
  if (!await Task.exists({ callId: call._id, isDemo: true })) {
    await Task.insertMany(call.proposedTasks.map(item => ({ title: item.description, description: item.description, patientId: ramesh._id, callId: call._id, departmentId: item.departmentId, priority: item.priority, status: 'Pending Confirmation', sourceExcerpt: item.sourceExcerpt, isDemo: true, createdBy: admin._id, history: [{ status: 'Pending Confirmation', note: 'Synthetic demo task. Confirm before assignment.', by: admin._id }] })));
  }
  if (!await Appointment.exists({ patientId: ramesh._id, isDemo: true })) await Appointment.create({ patientId: ramesh._id, departmentId: departments.Cardiology._id, providerName: 'Sample provider', scheduledAt: new Date(Date.now() + 86400000), room: 'Sample Room 206', confirmedByStaff: false, isDemo: true, createdBy: admin._id });
  const appointment = await Appointment.findOne({ patientId: ramesh._id, isDemo: true });
  if (!await DocumentChecklist.exists({ appointmentId: appointment._id, isDemo: true })) await DocumentChecklist.insertMany(['Previous reports (only if applicable)', 'Photo identification (sample checklist item)'].map(name => ({ patientId: ramesh._id, appointmentId: appointment._id, name, status: 'Required', isDemo: true, createdBy: admin._id })));
  console.log(`Synthetic CareFlow sample records are ready (patients: ${await Patient.countDocuments({ isDemo: true })}, calls: ${await Call.countDocuments({ isDemo: true })}, tasks: ${await Task.countDocuments({ isDemo: true })}). No live patient data was added.`);
  });
} catch (error) {
  console.error(`Demo seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

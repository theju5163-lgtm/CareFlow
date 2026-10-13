// @ts-nocheck
import 'dotenv/config';
import mongoose from 'mongoose';
import { Hospital, HospitalMembership, User, Patient, Department, Call, Task, Appointment, Admission, Discharge, InsuranceCase, BillingRecord, MedicalRecord, DocumentChecklist, FollowUp, AuditLog } from './models.js';
import { connectDatabase } from './app.js';

if (!process.argv.includes('--confirm')) throw new Error('This migration changes existing records. Review the target database and rerun with --confirm to assign all legacy records to the default hospital.');

try {
  const hospital = await connectDatabase();
  if (!hospital?._id) throw new Error('The default hospital workspace is unavailable.');
  const tenantId = hospital._id;
  const collections = [Patient, Department, Call, Task, Appointment, Admission, Discharge, InsuranceCase, BillingRecord, MedicalRecord, DocumentChecklist, FollowUp, AuditLog];
  const results = [];
  for (const Model of collections) {
    const result = await Model.collection.updateMany({ hospitalId: { $exists: false } }, { $set: { hospitalId: tenantId } });
    results.push(`${Model.modelName}: ${result.modifiedCount}`);
  }
  const users = await User.collection.updateMany({ $or: [{ hospitalIds: { $exists: false } }, { hospitalIds: { $size: 0 } }] }, { $set: { hospitalId: tenantId, hospitalIds: [tenantId] } });
  results.push(`User: ${users.modifiedCount}`);
  const legacyUsers = await User.find({ hospitalIds: tenantId }).select('_id role departmentId').lean();
  for (const user of legacyUsers) await HospitalMembership.updateOne({ hospitalId: tenantId, userId: user._id }, { $setOnInsert: { role: user.role || 'staff', departmentId: user.departmentId || null, patientId: user.patientId || null, active: true } }, { upsert: true });
  try { await Department.collection.dropIndex('name_1_isDemo_1'); } catch (error) { if (error.codeName !== 'IndexNotFound') throw error; }
  console.log(`Legacy records assigned to ${hospital.name} (${tenantId}). Updated: ${results.join(', ')}. Existing patient data was moved by explicit operator confirmation.`);
} finally {
  await mongoose.disconnect();
}

import jwt, { type SignOptions, type JwtPayload } from 'jsonwebtoken';

export const ROLES = Object.freeze({
  admin: ['*'],
  coordinator: ['workspace:read', 'patient:read', 'patient:write', 'call:read', 'call:write', 'task:read', 'task:write', 'appointment:read', 'appointment:write', 'directory:read', 'message:draft', 'analytics:read', 'document:read', 'document:write', 'admission:read', 'admission:write', 'discharge:read', 'discharge:write', 'insurance:read', 'insurance:write', 'billing:read', 'billing:write', 'medical-record:read', 'medical-record:write'],
  staff: ['workspace:read', 'patient:read', 'call:read', 'call:write', 'task:read', 'task:write', 'appointment:read', 'directory:read', 'message:draft', 'analytics:read', 'document:read', 'document:write', 'admission:read', 'admission:write', 'discharge:read', 'insurance:read', 'billing:read', 'medical-record:read'],
  doctor: ['workspace:read', 'patient:read', 'call:read', 'task:read', 'appointment:read', 'medical-record:read', 'admission:read', 'discharge:read'],
  nurse: ['workspace:read', 'patient:read', 'call:read', 'task:read', 'appointment:read', 'medical-record:read', 'admission:read', 'discharge:read'],
  receptionist: ['workspace:read', 'patient:read', 'patient:write', 'call:read', 'call:write', 'task:read', 'task:write', 'appointment:read', 'appointment:write', 'directory:read', 'message:draft'],
  appointment_coordinator: ['workspace:read', 'patient:read', 'call:read', 'call:write', 'task:read', 'task:write', 'appointment:read', 'appointment:write', 'directory:read', 'message:draft'],
  admission_coordinator: ['workspace:read', 'patient:read', 'call:read', 'task:read', 'task:write', 'admission:read', 'admission:write', 'insurance:read', 'document:read', 'document:write'],
  discharge_coordinator: ['workspace:read', 'patient:read', 'call:read', 'task:read', 'task:write', 'discharge:read', 'discharge:write', 'billing:read', 'insurance:read', 'document:read', 'document:write'],
  medical_records_officer: ['workspace:read', 'patient:read', 'task:read', 'task:write', 'medical-record:read', 'medical-record:write', 'document:read', 'document:write'],
  insurance_officer: ['workspace:read', 'patient:read', 'task:read', 'task:write', 'insurance:read', 'insurance:write', 'document:read', 'document:write'],
  billing_officer: ['workspace:read', 'patient:read', 'task:read', 'task:write', 'billing:read', 'billing:write'],
  patient_relations_officer: ['workspace:read', 'patient:read', 'call:read', 'call:write', 'task:read', 'task:write', 'message:draft', 'analytics:read'],
  supervisor: ['workspace:read', 'patient:read', 'call:read', 'call:write', 'task:read', 'task:write', 'appointment:read', 'appointment:write', 'directory:read', 'message:draft', 'analytics:read', 'document:read', 'document:write', 'admission:read', 'admission:write', 'discharge:read', 'discharge:write', 'insurance:read', 'insurance:write', 'billing:read', 'billing:write', 'medical-record:read', 'medical-record:write', 'audit:read'],
  auditor: ['workspace:read', 'patient:read', 'call:read', 'task:read', 'appointment:read', 'directory:read', 'analytics:read', 'document:read', 'admission:read', 'discharge:read', 'insurance:read', 'billing:read', 'medical-record:read', 'audit:read'],
  patient: ['patient:portal:read', 'directory:read']
});

export function can(role, permission) {
  const rules = ROLES[role] || [];
  return rules.includes('*') || rules.includes(permission);
}

export function roleMatchesAccountType(role: string, accountType: string) {
  if (accountType === 'patient') return role === 'patient';
  if (accountType === 'admin') return role === 'admin';
  if (accountType === 'staff') return !['patient', 'admin'].includes(role);
  return false;
}

export function signAccessToken(user: { _id: unknown; role: string; email: string }, secret: string, expiresIn: SignOptions['expiresIn'] = '8h', hospitalId?: string) {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
  return jwt.sign({ sub: String(user._id), role: user.role, email: user.email, ...(hospitalId ? { hospitalId } : {}) }, secret, { expiresIn, issuer: 'careflow-ai' });
}

export function verifyAccessToken(token: string, secret: string) {
  return jwt.verify(token, secret, { issuer: 'careflow-ai' }) as JwtPayload & { role: string; email: string };
}

export function validStatusTransition(from, to) {
  const transitions = {
    Draft: ['Pending Confirmation', 'Cancelled'],
    'Pending Confirmation': ['Pending', 'Cancelled', 'Escalated'],
    Pending: ['In Progress', 'Cancelled', 'Escalated'],
    'In Progress': ['Completed', 'Pending', 'Escalated', 'Cancelled'],
    Completed: [], Cancelled: [], Escalated: ['Pending', 'In Progress', 'Completed', 'Cancelled']
  };
  return from === to || Boolean(transitions[from]?.includes(to));
}

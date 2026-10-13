export type Role = 'admin' | 'coordinator' | 'staff' | 'patient' | 'doctor' | 'nurse' | 'receptionist' | 'appointment_coordinator' | 'admission_coordinator' | 'discharge_coordinator' | 'medical_records_officer' | 'insurance_officer' | 'billing_officer' | 'patient_relations_officer' | 'supervisor' | 'auditor';
export type DataMode = 'demo' | 'live';
export type TaskStatus = 'Draft' | 'Pending Confirmation' | 'Pending' | 'In Progress' | 'Completed' | 'Cancelled' | 'Escalated';

export interface AuthUser { id: string; name: string; email: string; role: Role; patientId?: string | null }
export interface HospitalRecord { _id?: string; id?: string; name: string; address?: string; city?: string; state?: string; status: 'pending_verification' | 'setup' | 'active' | 'suspended'; currency: string; timeZone: string }
export interface AuthResponse { token: string; hospitalId: string; hospitals: HospitalRecord[]; user: AuthUser }
export interface HealthStatus { status: string; database: string; databaseName: string; ai: string; speech: string; telephony: string; faceLogin: string; voiceLogin: string }
export interface DepartmentRecord { _id: string; name: string; description: string; isDemo: boolean }
export interface PatientRecord { _id: string; displayName: string; externalId: string; isDemo: boolean; createdAt: string }
export interface TranscriptSegment { _id: string; speaker: string; text: string; originalText?: string | null; at: string; confidence: number | null; uncertain: boolean; editedAt?: string | null }
export interface CallRecord { _id: string; callerLabel: string; status: string; category: string; language: string; verificationStatus: string; analysisStatus: string; analysisProvider: string; summary: string; patientId?: PatientRecord | null; transcript: TranscriptSegment[]; patientRequests: string[]; proposedTasks: Array<{ _id: string; description: string; departmentId?: DepartmentRecord | null; priority: string }> }
export interface TaskRecord { _id: string; title: string; status: TaskStatus; dueAt: string | null; priority: string; isDemo: boolean; patientId?: PatientRecord | null; departmentId?: DepartmentRecord | null }
export interface AppointmentRecord { _id: string; scheduledAt: string; confirmedByStaff: boolean; providerName: string; room: string; patientId?: PatientRecord | null; departmentId?: DepartmentRecord | null }
export interface DocumentRecord { _id: string; name: string; status: string; patientId?: PatientRecord | null }
export interface FollowUpRecord { _id: string; status: string; dueAt: string | null; note: string }
export interface WorkspaceResponse { mode: DataMode; calls: CallRecord[]; tasks: TaskRecord[]; appointments: AppointmentRecord[]; patients: PatientRecord[]; departments: DepartmentRecord[]; totals: { calls: number; tasks: number; patients: number; appointments: number; openTasks: number } }
export interface AnalyticsResponse { mode: DataMode; source: 'mongodb'; totalCalls: number; calls: Record<string, number>; tasks: Record<string, number>; averageDurationSeconds: number | null; callResolutionRate: number | null; taskCompletionRate: number | null; dailyCallVolume: Array<{ date: string; calls: number }>; satisfaction: null; aiAssistedResolutionRate: null; note: string }
export interface PatientPortalResponse { patient: PatientRecord; appointments: AppointmentRecord[]; callSummaries: CallRecord[]; tasks: TaskRecord[]; documents: DocumentRecord[]; followups: FollowUpRecord[] }

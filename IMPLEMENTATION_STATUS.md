# CareFlow AI storyboard implementation status

Status describes the current application in this repository. `Implemented` means a usable screen/workflow exists, not that it has been verified against a live hospital database. `Partial` means some of the requested workflow exists but material requirements remain. `Not implemented` means no working screen/workflow currently exists.

| # | Required page | Status | Current coverage / limitation |
|---:|---|---|---|
| 1 | Login | Implemented | Password login, loading/error state, hospital-scoped role; recovery provider not configured. |
| 2 | Hospital registration | Partial | Creates isolated pending-verification workspace and first admin; email/logo verification is not connected. |
| 3 | Hospital setup wizard | Not implemented | Departments can be configured in Settings; no step-by-step setup wizard. |
| 4 | Hospital selection | Implemented | Hospital switcher uses explicit memberships; administrators can grant a role scoped to each hospital. |
| 5 | Main dashboard | Partial | Database counts include patients, today's appointments, staff memberships, pending admissions/discharges, insurance/billing and calls/tasks; beds are not modeled. |
| 6 | Calling center | Partial | Exotel click-to-call is implemented behind credentials for verified live patient numbers; no configured credentials or real call test in this environment. Synthetic records are separate. |
| 7 | Active call | Partial | Exotel initiation, provider status polling/callbacks, and remote hangup requests are implemented; status awaits provider events. Live streaming and browser mute are not configured. |
| 8 | Call recording and transcription | Partial | Recording is requested only after staff confirms recording consent; provider recording references are retained privately and consented audio upload/transcription exists. Automatic provider recording retrieval and live streaming are not configured. |
| 9 | Call history | Partial | Stored call list with call/transcript details; some requested columns/filters are absent. |
| 10 | AI call analysis | Partial | Optional consent-gated structured summary/request extraction; requested categories/commitments are not comprehensive. |
| 11 | Evidence verification | Partial | Proposed actions retain transcript excerpts; no dedicated evidence-review workflow for every fact. |
| 12 | AI action review | Partial | Each proposed task has transcript evidence and individual edit/approve/reject controls. Clarification and reassignment review lifecycle remains incomplete. |
| 13 | Action queue | Partial | Tasks, statuses, priority and assignment; separate pending-review/approved/rejected views are incomplete. |
| 14 | Task details | Partial | Task status, assignee, due date and notes exist; source conversation/history detail view is limited. |
| 15 | Department work queue | Partial | Tasks can be department-assigned; dedicated department queue screen is absent. |
| 16 | Task resolution | Partial | Status transitions, notes and history exist; resolution-evidence workflow is incomplete. |
| 17 | Department directory | Removed | Standalone page and department-management UI/API creation route removed per updated project requirements; legacy lookups remain for existing records. |
| 18 | Department details | Not implemented | No dedicated department profile/queue view. |
| 19 | Staff directory | Partial | Hospital membership list, role, activation, staff ID, job title and department controls; assignment history is absent. |
| 20 | Staff profile | Not implemented | No dedicated staff profile/assignment history screen. |
| 21 | User roles and permissions | Partial | Backend enforces a 16-role catalog per hospital and tasks route to staff-role labels; a custom permission editor is absent. |
| 22 | Patient directory | Implemented | Tenant-scoped patient records and search; fields are intentionally limited by authorization. |
| 23 | Patient registration | Partial | Patient creation exists; duplicate detection and full registration/identity validation are incomplete. |
| 24 | Patient profile | Partial | Patient details and related records exist in limited views; requested full tab set is absent. |
| 25 | Patient journey | Not implemented | No complete cross-module timeline. |
| 26 | Appointment dashboard | Partial | Appointment list/create/confirm flows; dashboard buckets for all appointment states are absent. |
| 27 | Appointment calendar | Not implemented | No day/week/month calendar. |
| 28 | Create appointment | Partial | Patient/department/date/provider/room entry; duration/type/reason/availability/source linkage is incomplete. |
| 29 | Appointment details | Partial | Appointment appears in lists and patient package preview; no full details/history page. |
| 30 | Reschedule or cancel appointment | Not implemented | Confirmation exists; full reschedule/cancel/availability flow does not. |
| 31 | Follow-up appointments | Not implemented | No discharge-linked appointment slot workflow. |
| 32 | Admission dashboard | Partial | Tenant-scoped admission queue/status counts exist; full separate dashboard buckets are absent. |
| 33 | Create admission request | Partial | Patient, department, date, type and status record; full document/insurance/coordinator workflow remains. |
| 34 | Admission details | Partial | Records show in a hospital queue; no full details/history screen. |
| 35 | Admission work queue | Partial | Status queue exists; coordinator assignment and missing-document views are incomplete. |
| 36 | Admission history | Partial | Status changes are audited and stored; dedicated timeline/related-conversation view is absent. |
| 37 | Discharge dashboard | Partial | Tenant-scoped discharge queue exists; dedicated dashboard buckets are absent. |
| 38 | Create discharge request | Partial | Patient, department and planned date are supported; admission linkage and full checklist are limited. |
| 39 | Discharge details | Partial | Clearance fields/status are stored and completion is gated; there is no full details/history page. |
| 40 | Discharge document tracking | Partial | Generic checklist plus discharge clearance fields; no end-to-end release/delivery workflow. |
| 41 | Post-discharge follow-up | Partial | Follow-up task primitives exist; no discharge-linked communication workflow. |
| 42 | Insurance dashboard | Partial | Tenant-scoped insurance case queue/status counts; full document buckets are absent. |
| 43 | Insurance case details | Partial | Provider/reference/doc labels/status and assignment are stored; no full history/detail page. |
| 44 | Insurance document tracking | Partial | Required/submitted document labels are stored; no per-document verification workflow. |
| 45 | Billing dashboard | Partial | Tenant-scoped billing records/status counts; no transaction/aging dashboard. |
| 46 | Billing record details | Partial | Invoice reference, explicitly entered amount, currency, payment status and enquiry are stored; no transaction detail history view. |
| 47 | Medical records dashboard | Partial | Tenant-scoped request list with preparation/approval/release/delivery statuses. |
| 48 | Document details | Partial | Metadata/status only; document content is not stored and release controls are incomplete. |
| 49 | Communication center | Partial | Local draft preview from staff-confirmed appointments; delivery is not integrated. |
| 50 | Follow-up tasks | Partial | Follow-ups link to tasks; last-attempt/outcome/next-action UI is incomplete. |
| 51 | Escalations | Partial | Task escalation status exists; supervisor escalation dashboard is absent. |
| 52 | Notification history | Not implemented | No delivery provider/history records. |
| 53 | Analytics dashboard | Partial | Call/task analytics plus dashboard counts for admissions/discharges/insurance/billing; trend analytics for those areas are not available. |
| 54 | Reports | Not implemented | No authorized CSV export/report filters. |
| 55 | Hospital settings | Partial | Hospital profile, currency and time zone can be edited; logo and wider operational settings are absent. |
| 56 | Calling and AI settings | Not implemented | Provider secrets are environment-only; no provider configuration UI. |
| 57 | Security and audit logs | Partial | Audit events and admin view exist; full event coverage/filters/export are incomplete. |
| 58 | Data import | Not implemented | No CSV import workflow. |
| 59 | Error and processing status | Partial | Request/processing errors appear in the UI and service status is shown; no central retry queue. |

## Tenant and data controls

- Hospital-owned MongoDB models are filtered by the active hospital in reads, updates, deletes, counts, distinct queries and analytics aggregates.
- Hospital membership and role are checked on every protected request. Roles are scoped per hospital.
- Existing records created before tenant scoping are hidden until an operator explicitly runs the legacy migration after backing up and confirming the target.
- Demo and live records remain separated within each hospital.
- Exotel calls require an explicit staff action, a verified live patient number, recording-consent attestation before provider recording, and a token-protected HTTPS callback. Exotel was not configured or contacted during tests.
- Database-backed tenant behavior is covered by unit-level middleware tests; it has not yet been exercised against a running MongoDB server in this environment.

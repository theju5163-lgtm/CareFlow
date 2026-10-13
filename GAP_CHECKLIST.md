# CareFlowAI gap checklist (2026-10-13)

Scope: inspected the existing React/Vite frontend, Express/Mongoose backend, authentication/permissions, MongoDB config, APIs, integrations, UI, README, and tests before incremental changes. Status is based on source inspection unless runtime evidence is stated.

## Requirement gaps

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Structure and startup | Running | Existing frontend `localhost:5173` returned HTTP 200; API `localhost:4100` responded. A second `npm run dev` found those ports occupied (extra Vite selected 5176; extra API failed EADDRINUSE) and was stopped. |
| MongoDB / tenant isolation | Connected and implemented | `/api/health` reported `ok`, MongoDB `connected`, database `careflow_ai`. Tenant scoping has unit tests. Protected-record CRUD was not exercised in this pass. |
| Authentication / RBAC | Partial | bcrypt/JWT, hospital membership, backend role checks and login account-type choice checked against actual membership role. No ID login or forgot-password. Stored-user login was not tested. |
| Patient portal / ownership | Partial | Linked patient reads only own data; sees approved portal messages, upcoming and past appointments, requests. Can request booking/reschedule/cancellation. No patient self-registration/profile edit, contact-support, or notification inbox. |
| Appointments | Partial | Staff can create/list/review; patient requests persisted; staff approval/decline; 30-minute conflict window on confirmation. No slot availability calendar or full transition history/notifications. |
| Communications | Partial | Persisted messages require staff approval; only approved portal messages display to that patient. SMS/email are not sent without provider configuration; no provider callbacks/deduplication. |
| Department and staff management | Implemented in source; live CRUD unverified | Added an admin Departments page, idempotent 10-department initializer, counts, department details, manager assignment, staff directory/search/filter, secure staff-account creation, editing, reassignment, activation/deactivation, unique indexes, and audit records. Runtime CRUD was not executed because shell localhost sockets are blocked and no authenticated token was available to the shell. |
| Calls / Exotel | Implemented behind config; not provider-tested | Adapter, idempotency, status callback, consent checks. Health says disabled; credentials and public callback host absent. |
| Transcription / AI | Implemented behind config; not provider-tested | Optional consent-gated OpenAI processing, staff review. Health says disabled; no live streaming; AI actions/commitments are limited and must be reviewed. |
| Action queue / follow-ups | Partial | Tasks, review-gated action creation, assignments/status history/follow-up records. Queue filters, complete history, processing retry queue and routing confidence are incomplete. |
| Patient records | Partial | Tenant/data-mode scoped list/create and phone verification. No self-service profile editing or duplicate detection. |
| Documents | Partial | Checklist labels/status only; no secure upload storage configured. |
| Analytics / operations | Partial | Counts derive from Mongo records; full job/integration error monitor and retry queue are absent. |
| Responsive/accessibility/design | Partial | Shared UI components and responsive CSS exist. Only one dashboard screenshot was inspected; user stopped computer-use actions with Escape, so no further visual or keyboard verification was performed. |
| Synthetic data | Implemented | Idempotent demo seeder, `isDemo` isolation. Seed was not run in this pass. |
| Secrets / source package | Needs caution | Extra nested `CareFlowAI-VSCode-Source` copy and ZIP already exist; canonical source is the root project. Local `backend/.env` must never be included or exposed. |

## Changes in this pass

- Added persisted, approval-gated patient portal messages and truthful delivery status.
- Added patient appointment and reschedule requests, staff review, and conflict validation.
- Added patient cancellation requests with staff approval/decline.
- Added admin-only department CRUD within Settings, preserving old rows without `active` as active.
- Added a dedicated admin Departments page. Staff records reuse `User` and hospital-scoped `HospitalMembership`; no duplicate Staff model/collection was created.
- Added membership profile fields and scoped uniqueness indexes for employee IDs and department codes, live department defaults, department staff counts, staff profile/reassignment APIs, manager validation and audit entries.
- Added patient/staff/admin account-type selection and backend membership-role matching at login.

## Verification

- Backend TypeScript build after staff/department changes: passed (`npm run build:all`).
- Frontend TypeScript check and production build after changes: passed; Vite reports the existing large-bundle warning (~727 kB JS).
- Backend unit tests: 10 passed, 0 failed. These cover security, tenant scoping, task transitions, phone validation, Exotel status normalization, membership schema relationships, and scoped uniqueness indexes; they do not exercise staff CRUD.
- Shell attempts to reach localhost HTTP endpoints failed with an operating-system socket permission error. Existing prior-turn health evidence reported MongoDB connected to `careflow_ai`, but current authenticated CRUD, persistence after restart, and duplicate rejection were not reverified.
- Stored-user login, appointment/message end-to-end, Exotel, and OpenAI were not tested. AI, speech and telephony report disabled.

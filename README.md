# CareFlow AI · DL-VVCE-HK26-HLS00

This project preserves the initial design artifact and runs a React/Vite frontend with its existing Node.js/Express/Mongoose backend. Synthetic sample records and live workspace records use separate `isDemo` filters. There are no default logins. The pasted brief mentioned FastAPI, but the inspected existing project is Express; this implementation keeps that existing backend instead of adding a duplicate server.

## Run locally on Windows

Requirements: Node.js 20+, npm, and either Docker Desktop or MongoDB Server.

1. From this project directory, start MongoDB:

   ```powershell
   docker compose up -d mongodb
   ```

   If Docker is not installed but MongoDB Server is installed and `mongod` is on `PATH`, use a separate PowerShell window instead:

   ```powershell
   New-Item -ItemType Directory -Force .local/mongodb | Out-Null
   mongod --dbpath "$PWD/.local/mongodb" --bind_ip 127.0.0.1 --port 27017
   ```

   Keep that window open while using CareFlow. Install MongoDB Community Server on the destination computer and make sure `mongod` is available on `PATH`, or use Docker Desktop.

2. Create the backend environment file and edit the values locally:

   ```powershell
   Copy-Item .env.example backend/.env
   ```

   Set `JWT_SECRET` to a random secret of at least 32 characters. `MONGODB_URI` defaults to localhost and the backend selects the `careflow_ai` database. Keep `OPENAI_API_KEY` blank and `AI_EXTERNAL_PROCESSING_ENABLED=false` until authorized processing is configured. Administrator passwords are entered interactively for the bootstrap command and are never stored in `.env`.

3. Install root and app dependencies:

   ```powershell
   npm install
   npm --prefix backend install
   npm --prefix frontend install
   ```

4. Create the initial administrator:

   ```powershell
   npm run admin:bootstrap
   ```

   The command prompts for the administrator email/name and asks for the password twice without echoing it. The password is stored in MongoDB only as a bcrypt hash. To rotate an existing administrator password, pass `-- --email admin@careflow.local --reset-existing`; use this only from a trusted local terminal.

5. Seed isolated synthetic demonstration records (optional):

   ```powershell
   npm run seed:demo
   ```

   An active administrator is used as the synthetic seed author. The seeder does not modify live records.

6. Start API and web development servers:

   ```powershell
   npm run dev
   ```

   Open `http://localhost:5173`. The frontend proxies `/api` to `http://localhost:4100`. Sign in with the email and password set during administrator bootstrap.

## Commands

- `npm run dev` — start both development servers.
- `npm run build` — create the production frontend bundle in `frontend/dist`.
- `npm run build:backend` — compile the backend TypeScript into `backend/dist`.
- `npm run build:all` — compile the backend and build the frontend.
- `npm test` — run backend unit tests.
- `npm run seed:demo` — idempotently add synthetic records.
- `npm run admin:bootstrap` — securely create the initial administrator; prompts for credentials without storing the password in configuration.
- From the admin dashboard, open **Departments** and use **Initialize default departments** to idempotently add any missing live departments. This action does not overwrite descriptions or remove existing departments.
- `npm --prefix backend run migrate:tenant` — explicitly assign pre-existing unscoped records to the default hospital. Back up the database and inspect the target first; do not run this on data that already contains more than one hospital.

The backend can start without MongoDB to expose `/api/health`; protected data routes report HTTP 503 until MongoDB connects. Configure MongoDB before attempting login or data workflows.

## Real outbound calls (Exotel)

The backend has an Exotel click-to-call adapter for India. It requires an Exotel account that has completed provider onboarding/KYC, API key, API token, Account SID, an assigned ExoPhone caller ID, and a public HTTPS callback host. Copy the placeholder values from `.env.example` to `backend/.env`; never commit real credentials. `EXOTEL_BASE_URL` must be `https://api.in.exotel.com` for a Mumbai account or `https://api.exotel.com` for a Singapore account. Set a random `EXOTEL_WEBHOOK_TOKEN` of at least 32 characters. Expose backend port 4100 through a secure HTTPS tunnel or deployment and set the root origin in `EXOTEL_PUBLIC_BASE_URL`.

In Live records mode, staff select a live patient whose phone number has been verified, enter their own hospital-authorized agent number, and explicitly confirm authorization before clicking **Call Patient**. Exotel calls the agent first, then the patient. The app does not treat API acceptance as a connected call; callback events drive the displayed state. The End Call action requests provider hangup and waits for a terminal callback. Call creation is idempotent per browser request. Recording is disabled unless the staff member records consent for that call. Separate patient consent for external AI processing is still required before speech transcription or AI analysis.

Live audio streaming and browser mute are not configured. A provider recording can be downloaded through the provider and uploaded to the authorized transcription workflow after the call. Provider callback status is token-protected; deploy only behind HTTPS and keep the callback token secret. Before purchasing, check [Exotel’s current pricing](https://cdnweb.exotel.com/pricing/) directly: plans, ExoPhone rental, per-leg call minutes, and streaming add-ons affect cost and prices change. Current Exotel API setup requires account credentials and a virtual number; account/KYC approval and actual outbound calling remain provider-side prerequisites.

## Implemented workflow

Call record → speaker-labelled transcript entry or consent-gated audio transcription → optional consent-gated OpenAI structured analysis → editable staff-review draft → staff approval → department-routable tasks → task history and follow-ups → MongoDB-derived analytics. Patients can request appointments, reschedules, and cancellations; staff review each request, and only confirmed changes are effective. Staff-authored patient-portal messages are persisted as drafts, require approval, and become visible only in the linked patient portal. SMS/email remain not sent unless a delivery integration is configured. Patient-information package previews use only staff-confirmed appointment details and checklist items.

### Staff and department management

Administrators have a **Departments** sidebar page backed by the existing hospital-scoped `Department` and `HospitalMembership` models. Staff login identities remain in `users`; employee ID, job title, phone, assigned department, role, and active status are stored on that user's hospital membership. This avoids creating duplicate `Staff` or authentication collections. Department manager references point to a `HospitalMembership` ID and are accepted only for active staff assigned to that department. Staff additions require an administrator-set temporary password of at least 12 characters; the backend stores only a bcrypt hash.

The page lists department code, description, counts and status; opens detail by MongoDB ObjectId; adds and edits departments and staff; filters the staff directory; permits reassignment; assigns managers; and activates/deactivates staff and departments. Management uses live hospital configuration even when the synthetic demo-data mode is selected. Department codes and employee IDs are unique within their hospital scope. Existing unassigned memberships remain unassigned, and completed tasks retain their historical department IDs.

Management API routes include `GET/POST /api/departments`, `GET/PATCH /api/departments/:id`, `POST /api/departments/initialize`, `GET /api/departments/:id/staff`, `GET/POST /api/staff`, `GET /api/staff/:id`, and `PATCH /api/staff/:id`. All modifying routes enforce administrator authorization on the server and write audit events. Department counts are calculated from membership records; no cached count can drift.

The transcript is stored separately from the administrative summary. Transcript corrections retain the original text, editor, and timestamp. AI due dates are not inferred. No diagnosis or treatment plan is generated. Audio bytes are held in memory only for the transcription request and are not persisted by this app.

## Configuration and limitations

- MongoDB is required for authentication and data workflows. The configured database name is `careflow_ai`.
- To enable OpenAI analysis or speech processing, set `OPENAI_API_KEY` and explicitly set `AI_EXTERNAL_PROCESSING_ENABLED=true` in `backend/.env`. External requests require an associated patient record, verified patient identity, and recorded processing consent. Speech uploads are not stored by the application. Follow your institution's privacy and retention requirements before enabling.
- Speech transcription is a file-upload action, not live microphone streaming. Multilingual selection can pass configured language hints; language support has not been validated for this deployment.
- No SMS, WhatsApp, email, or EHR delivery integration is configured. Real phone calls are implemented behind Exotel credentials; without them, the app clearly disables live calling. Department and staff CRUD is implemented but has not been exercised against this running account's authenticated MongoDB data during this task; builds and automated tests are reported separately below.
- Authorization roles are enforced on backend routes. This is a hackathon demonstration, not a production medical system; deployment still needs security, privacy, retention, and clinical workflow review.
- Hospital role catalog includes administrator, coordinator, staff, patient, clinical, operational specialist, supervisor, and auditor roles. A configurable custom permission editor is not implemented. Patient self-registration and profile editing are not configured; administrators must create a linked patient account. Appointment conflict checks run when staff confirms a booking and use a 30-minute slot assumption; there is no availability calendar.
- Organization-owned records are automatically scoped by the active authorized hospital on queries, updates, deletes, inserts, and analytics. Existing pre-tenancy records remain hidden until the explicit migration command is run. Hospital registration is self-serve and status is marked pending verification; an external verification provider is not configured.

## Verification

The backend TypeScript build, frontend TypeScript check, and production build pass. Backend unit tests: 10 passed, 0 failed. The shell in this task was blocked from localhost socket access, so the authenticated staff/department workflows and current MongoDB health could not be exercised. Earlier project-session health evidence showed MongoDB connected to `careflow_ai`; that is not a verification of these new CRUD operations. Exotel and OpenAI were not contacted; their status is disabled until credentials and consented test data are configured. See `GAP_CHECKLIST.md` for the current verification boundary.

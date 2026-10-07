# FieldForms: phased task list

Status key: `[ ]` not started · `[x]` done and covered by automated tests · `[~]` done, partly
tested or tested by hand only (see the notes)

## Phase 0: Scaffold

- [x] ARCHITECTURE.md and TASKS.md
- [x] pnpm workspace, TypeScript, ESLint (bans `eval`/`new Function`), Prettier
- [x] Docker compose (postgres, migrate, seed, api, worker, gotenberg, mailpit, web) and `.env.example`
- [x] Plain-SQL migration runner with checksums and an advisory lock

## Phase 1: Attendance MVP (supervisor register)

- [x] Migrations: domain model, append-only triggers (UPDATE/DELETE/TRUNCATE), restricted app role
- [~] Auth: PIN and password sign-in, sessions, lockout, roles and scopes, CSRF header, audit
  (tested). OIDC for Microsoft 365 / Google is written but **untested** (no identity provider
  available here). Rate limits are configured but not exercised by a test.
- [~] Admin: users and settings APIs are tested; the company, region, site, shift and employee
  endpoints and all admin screens were exercised by hand only.
- [x] Shared: schemas, shift-time and night-shift maths, geofence and time-window checks, clock
      skew vs sync delay, sync engine (unit tests)
- [x] PWA: install manifest, service worker, POPIA consent, offline roster cache, register flows,
      outbox, sync status, IndexedDB store (unit tests and Playwright)
- [x] API: idempotent registers and photos, server-side flags, email summary jobs with PDF
- [x] Corrections with required reason and history; manual clock events
- [x] Daily report, XLSX and CSV export, view and export audit logging
- [x] Seed data (deterministic, refuses to run twice)
- [~] Legacy importer, tested on a generated workbook only, **not** on a real export of the
  production sheet
- [x] Playwright acceptance test (airplane mode → clock in → reconnect → exactly one record),
      plus a lost response, a server outage, a reload mid-upload and the manager correction flow
- [x] README and CLAUDE.md; `create-admin` command for an empty production database

### Phase 1 report

**Verified by running it:**

- 37 shared unit tests, 7 IndexedDB outbox tests and 47 API integration tests against Postgres 16.
- 5 Playwright tests on the production PWA build (Chromium, Pixel 7 profile).
- `docker compose up` from empty volumes: migrations, seed, API health, PWA served by nginx with
  CSP, service worker registered, a register synced, the summary email with its Gotenberg PDF
  received in Mailpit, `create-admin`, and a legacy import inside the container. The startup
  sequence was repeated three times without errors.

**Not tested, or tested only by hand:**

- OIDC sign-in (Microsoft 365, Google): needs a real tenant and client registration.
- S3 photo storage: compose uses a Docker volume; the S3 driver has not run against S3.
- Real SMTP delivery: tested with Mailpit only.
- Real phones: Android Background Sync while the app is closed, iOS Safari install and offline
  behaviour, camera capture, on-device photo compression and real GPS accuracy. The tests use
  desktop Chromium with emulated offline mode and geolocation, and no photos are attached in the
  browser tests (photo upload is tested at the API level).
- Session expiry while registers are queued: covered by unit tests of the engine and store, but
  not end to end.
- `/admin/retention` review list and rate limiting: no automated test.
- Docker image builds in this sandbox needed its TLS-intercepting proxy's CA injected into
  temporary copies of the Dockerfiles. The committed Dockerfiles are unchanged and expected to
  build normally elsewhere.

**Known limitations to decide on:**

- The report does not flag an employee on the roster who was left off the day's register entirely
  (only missing IN/OUT for people who were recorded).
- A supervisor can submit a second start register for the same shift and date; they are warned on
  the phone, and the report still shows one row per employee per day.
- The main JavaScript bundle is about 535 KB (163 KB gzipped); code-splitting the admin and report
  screens would speed up the supervisors' first load on slow connections.

## Phase 2: Form builder and field types

- [ ] Versioned form definitions; immutable published versions; submissions record their version
- [ ] Field-type registry and all field types in the brief
- [ ] Safe expression engine (no eval) with unit and property tests
- [ ] Generic offline outbox (from the Phase 1 engine), drafts, cached forms and lists
- [ ] Dispatch to inbox with email notification

## Phase 3: Outputs and destinations

- [ ] Renderers: PDF, DOCX, XLSX, JSON, XML, images; branded templates
- [ ] Destination adapter interface, per-form destinations, rules
- [ ] Delivery log, retries, dead-letter queue with alert, manual redeliver
- [ ] Adapters: SMTP, webhook, SFTP, S3, Google Drive, OneDrive, Slack, SQL, Google Sheets
- [ ] REST API with API keys; secrets encrypted at rest

## Phase 4: Dashboards

- [ ] Chart builder (bar, line, pie, table, map), date filters, saved dashboards, PNG export
- [ ] Preset attendance dashboard

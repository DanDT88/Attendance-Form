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
- ~~The main JavaScript bundle is about 535 KB~~: fixed in Phase 2. Admin, reports, the form
  builder, submissions and the barcode reader load on demand, and nginx now compresses responses.

**Fixed after the Phase 1 report:**

- Correcting an absence to "present" or "late" now asks for the arrival time (or departure time
  for a left-early entry) and creates the clock event; before, the corrected entry had no time
  and showed as missing IN. Covered by an API test and a Playwright test.
- The email sweeper stops retrying a register summary after 27 failed attempts, at least an hour
  apart, instead of retrying forever. Covered by an API test.

## Phase 2: Form builder and field types

- [x] Versioned form definitions; published versions are immutable (database trigger, no UPDATE
      grant); every submission records its `form_version_id`
- [~] Field types: text, number, select and multi-select (inline, managed list, CSV upload), date,
  time, datetime, calculated, geotag, image with a separate annotation layer (original kept),
  signature, barcode/QR (`BarcodeDetector`, falling back to zxing-wasm), repeat groups, and notes.
  All are covered by the shared runtime tests; the browser tests fill in text, select,
  multi-select, date, number, calculated, repeat groups, a photo with markup, a signature and a
  QR scan. **Time, datetime and geotag are not exercised in a browser.**
- [x] Required, validation and show/hide rules as expressions, enforced on the phone and again on
      the server, which stores its own calculated values
- [x] Safe expression engine (tokenizer + Pratt parser, tree-walking evaluator, no `eval`), with
      unit and property tests and limits on length, depth and steps
- [x] Offline: forms, lists and inbox cached in the bootstrap; drafts saved as you type; outbox
      with device UUIDs, retry with backoff and the sync status chip (shared with registers);
      photos compressed on the phone
- [x] Dispatch a pre-filled form to a user or a group, with an inbox and an email; tasks for a
      site reach only people who can submit for that site
- [~] Builder, lists and groups screens: building, checking and publishing a form is covered by
  Playwright; the CSV upload and group screens are not (their APIs are tested)
- [~] Submissions viewer with photos, markup layer, signature and JSON download: covered by the
  dispatch Playwright test and an API test of who may view what
- [ ] Attendance register as a built-in form: **not done, by decision** (see "Changes from the
      approved plan" in ARCHITECTURE.md)

### Phase 2 report

**Verified by running it:**

- 101 shared unit and property tests (expression engine, form validation and runtime, plus the
  Phase 1 maths and sync engine), 7 IndexedDB outbox tests and 71 API integration tests against
  Postgres 16.
- 9 Playwright tests on the production PWA build (Chromium, Pixel 7 profile). The 3 new ones are:
  - filling a form offline with a draft that survives a reload, live calculations, a photo with
    markup, a signature and a QR scan, sent exactly once on reconnect;
  - an admin building, checking and publishing a form;
  - a manager sending a pre-filled task to a group and a member completing it.
- `docker compose up` from empty volumes:
  - migration 0003 applied, and the demo form, list and group seeded;
  - a task emailed through Mailpit;
  - a group task shown only to the member who can see its site;
  - a signed submission stored once (the retry returned `duplicate`) with the line total
    recalculated by the server;
  - the task marked complete, and the submission and signature opened by the area manager.
- Gzip on in nginx (barcode reader 967 KB → 419 KB, offline bootstrap 6.8 KB → 2.2 KB). The
  service worker is now 40 KB gzipped, down from 64 KB.

**Found and fixed while testing Phase 2:**

- A group can span sites, so a group task for one site reached members who could not submit for
  that site; their submission was refused and stuck in the outbox. Found in the Docker smoke test;
  now covered by two API tests that fail without the fix.
- Dispatch pre-fill stored calculated values; they are now recalculated when the form is filled in.

**Not tested, or tested only partly:**

- Real phones: camera capture, drawing markup and signing with a finger, `BarcodeDetector` on
  Android Chrome (the browser test uses the zxing-wasm fallback by picking a QR image), and iOS
  Safari in general.
- Geotag, time and datetime fields in a browser (only in the shared runtime tests).
- The CSV upload and group admin screens (their APIs are tested).
- Real SMTP delivery of task emails (Mailpit and a recording mailer only).
- Performance of large forms on low-end phones: the whole form is re-evaluated on each change.
- A phone running out of storage while drafts hold many photos.
- One Playwright run of the "server outage" test failed once and has passed in every full run
  since (at least eight). The cause was not found. The test now bounds its clicks and prints the
  outbox state if it fails again.

**Known limitations to decide on:**

- Pre-filled answers for field ids the form does not have are dropped without an error. The
  dispatch screen cannot produce them, but a future public API (Phase 3) should reject them.
- When one group member completes a task, the others' drafts for it stay on their phones; if they
  submit, the submission is stored (nothing is lost) but does not change the task.
- The barcode reader (419 KB compressed) is precached on every phone, so it scans offline on
  iPhones, which have no `BarcodeDetector`. This costs data once per app update that changes it.
- The Phase 1 questions remain open: flagging roster employees left off a register, and blocking
  a second start register for the same shift.

## Phase 3: Outputs and destinations

- [ ] Renderers: PDF, DOCX, XLSX, JSON, XML, images; branded templates
- [ ] Destination adapter interface, per-form destinations, rules
- [ ] Delivery log, retries, dead-letter queue with alert, manual redeliver
- [ ] Adapters: SMTP, webhook, SFTP, S3, Google Drive, OneDrive, Slack, SQL, Google Sheets
- [ ] REST API with API keys; secrets encrypted at rest

## Phase 4: Dashboards

- [ ] Chart builder (bar, line, pie, table, map), date filters, saved dashboards, PNG export
- [ ] Preset attendance dashboard

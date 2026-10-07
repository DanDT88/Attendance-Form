# FieldForms — Phased task list

Status key: `[ ]` not started · `[~]` in progress · `[x]` done and tested · `[!]` done but untested (see notes)

## Phase 0: Scaffold
- [ ] ARCHITECTURE.md and TASKS.md
- [ ] pnpm workspace, TypeScript config, ESLint, Prettier
- [ ] Docker compose (postgres, minio, mailpit, gotenberg, api, worker, web), `.env.example`, health checks
- [ ] Migration runner and baseline migration

## Phase 1: Attendance MVP (supervisor register)
- [ ] Migrations: domain model, append-only triggers, app role grants
- [ ] Auth: PIN, password, OIDC; sessions; role and scope checks; rate limiting; lockout; audit log
- [ ] Admin UI and API: companies, regions, sites, shifts, employees, replacement pool, users, settings
- [ ] Shared: schemas, time and compliance maths, sync engine, with unit tests
- [ ] PWA: manifest, service worker, POPIA consent, offline cache, register flows (start, late, left early, end), photos, GPS on submit, outbox, sync status
- [ ] API: idempotent registers and blobs, server-side flags, email summary jobs
- [ ] Corrections with required reason and history; manual clock events
- [ ] Daily report, XLSX and CSV export, view and export audit logging
- [ ] Seed data
- [ ] Legacy importer with a generated test fixture
- [ ] Tests: API integration, Playwright offline acceptance tests
- [ ] README and CLAUDE.md; phase report

## Phase 2: Form builder and field types
- [ ] Versioned form definitions; immutable published versions; submissions record their version
- [ ] Field-type registry and all field types in the brief
- [ ] Safe expression engine (no eval) with unit and property tests
- [ ] Generic offline outbox, drafts, cached forms and lists
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

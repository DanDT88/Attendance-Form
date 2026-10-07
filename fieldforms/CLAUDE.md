# FieldForms — notes for Claude

FieldForms lives in `fieldforms/` (a pnpm workspace). The files at the repository root
(`Code.gs`, `*.html`, `sw.js`, `config.js`) are the **legacy** Google Apps Script app that is still
live on GitHub Pages; do not change them as part of FieldForms work.

Read `ARCHITECTURE.md` before structural changes and keep `TASKS.md` current.

## Commands (run from `fieldforms/`)

| What                                       | Command                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Install                                    | `pnpm install`                                                                                                                     |
| Postgres + Mailpit for dev/tests           | `docker compose up -d postgres mailpit`                                                                                            |
| Migrate (owner connection)                 | `MIGRATION_DATABASE_URL=postgres://fieldforms:devpassword@localhost:5432/fieldforms APP_DB_PASSWORD=dev-app-password pnpm migrate` |
| Seed demo data                             | `DATABASE_URL=postgres://fieldforms_app:dev-app-password@localhost:5432/fieldforms pnpm seed`                                      |
| Run API / worker / web                     | `pnpm dev:api` · `pnpm dev:worker` · `pnpm dev:web` (set `DATABASE_URL` for the first two)                                         |
| All unit + integration tests               | `pnpm test`                                                                                                                        |
| One package's tests                        | `pnpm --filter @fieldforms/api test` (or `shared`, `web`)                                                                          |
| End-to-end (Playwright, offline scenarios) | `pnpm e2e`                                                                                                                         |
| Typecheck / lint / format                  | `pnpm typecheck` · `pnpm lint` · `pnpm format`                                                                                     |
| Full stack in Docker                       | `docker compose up -d --build` → http://localhost:8080 (Mailpit :8025)                                                             |
| First admin in production                  | `docker compose run --rm -e ADMIN_EMAIL=… -e ADMIN_PASSWORD api node dist/create-admin.js`                                         |
| Legacy import                              | `pnpm import-legacy export.xlsx` (needs `DATABASE_URL`)                                                                            |
| Regenerate PWA icons                       | `pnpm icons`                                                                                                                       |
| Key pair for destination secrets           | `pnpm secrets-keygen` (public key → API, private key → worker only)                                                                |
| Re-seal secrets after a key rotation       | `pnpm rotate-secrets` (worker environment: new `SECRETS_PRIVATE_KEY`, old one as `SECRETS_PRIVATE_KEY_PREVIOUS`)                   |

Tests need Postgres on `localhost:5432` with the compose credentials (override with
`TEST_DATABASE_URL` / `E2E_DATABASE_ADMIN_URL`). Playwright uses the Chromium in
`PLAYWRIGHT_BROWSERS_PATH` and is pinned to 1.56.1 to match it.

## Rules that are easy to break

- **Attendance is append-only.** `register_submissions`, `attendance_entries`, `entry_corrections`,
  `audit_log`, `notification_log` and `privacy_requests` have triggers that reject UPDATE/DELETE,
  and the API's DB role (`fieldforms_app`) has no DELETE (except on `sessions`, `user_scopes` and
  `user_group_members`). Change data by inserting a correction or a
  manual event, never by updating rows. No hard deletes anywhere: deactivate.
- **Migrations are plain SQL** in `apps/api/migrations`, applied in name order. Never edit an applied
  migration (the runner checks checksums); add a new file.
- **Times:** store `timestamptz` (UTC); display in `Africa/Johannesburg` via `formatLocal`.
  `date` columns are parsed as `YYYY-MM-DD` strings. Night shifts belong to the work date they
  start on; use `resolveShiftTime` / `shiftWindow` from `@fieldforms/shared`.
- **Idempotency:** registers and photos are keyed by client-generated UUIDs. Keep server writes
  `ON CONFLICT DO NOTHING`-safe and keep the sync engine free of browser APIs.
- **Every route checks role and scope on the server** (`requireUser` / `requireRole`, `assertSite`).
  Views and exports of attendance data must write an audit row.
- **Mutating requests need the `x-fieldforms: 1` header** (CSRF guard).
- **POPIA:** GPS is read only at submit time. Do not add background location, biometrics or extra
  personal fields without updating the privacy notice in settings.
- **No secrets in the repo.** Defaults in `docker-compose.yml` are for local development only.
- **No `eval`/`new Function`** (ESLint enforces this). Form expressions go through the parser and
  tree-walking evaluator in `packages/shared/src/expr`; add functions to the whitelist table in
  `functions.ts`, with tests, and never let an identifier resolve to a JavaScript object.
- **Published form versions never change.** Edit the form's draft and publish a new version;
  submissions point at the exact version they were filled in with. `form_versions`,
  `form_submissions` and `form_submission_files` are append-only like attendance.
- **The server re-runs every form** (`evaluateForm`) on the stored version and keeps its own
  calculated values; keep the runtime deterministic and identical in the browser and in Node.
- **A task for a site only goes to people who can see that site** (inbox, email and dispatch
  checks in `services/dispatch.ts` and `myOpenDispatches`).
- **The service worker imports `@fieldforms/shared/sync`, not the package root**, so zod and the
  form engine stay out of it.

### Phase 3 (documents, destinations, public API)

- **The `deliveries` row is the state machine and the lock.** Never send anything without first
  claiming the row (`runDelivery` in `services/delivery-runner.ts`); pg-boss only wakes workers
  (it does not enforce `singletonKey` on standard queues and cannot cancel a handler). Anything
  that creates or changes a delivery enqueues its job in the same transaction (`JobQueue`
  methods take the transaction).
- **Secrets are sealed to the worker.** The API holds only `SECRETS_PUBLIC_KEY` and must never
  open a secret; checks and test sends run in the worker. Never log, store, return or email a
  secret, a third party's response body or a raw socket error: adapters throw `DeliveryError`
  with a safe message and `redact()`ed detail. Changing a connection's binding fields clears its
  secrets.
- **Outbound connections to admin-configured hosts go through `lib/netguard.ts`** (guarded fetch,
  guarded lookup, or `resolveAllowed` + connect to the IP with the TLS server name).
- **Templates only through `lib/liquid.ts`** (never `new Liquid()`: its defaults read files and
  escape nothing), with the escaping context of where the output goes.
- **POPIA:** destinations get the document model after their `include` filter; never pass the
  unfiltered submission to an adapter or template.
- **File names carry the submission's short id** (`fileStem`), so two submissions never share a
  name, and a file is only replaced by a retry or resend of the same delivery.
- Parallel test runs against one Postgres need different `TEST_DB_PREFIX` values (`ffa`, `ffb`,
  not `ff` and `ff_b`).

## Layout

- `packages/shared` — zod schemas, time and compliance maths, the sync engine (`src/sync/engine.ts`),
  the expression language (`src/expr`) and form definitions and runtime (`src/forms`).
- `apps/api` — Fastify app (`src/app.ts`), routes, services, auth; `src/worker.ts` (pg-boss jobs);
  `src/outputs` (renderers, media, Gotenberg, templates), `src/destinations` (adapters, connection
  drivers, naming), `src/services/deliver*.ts` (the pipeline), `src/lib` (secrets, netguard, liquid);
  `src/scripts` (seed, legacy import, create-admin); `test/` (integration, one DB per file).
- `apps/web` — React PWA; `src/sw.ts` (service worker), `src/offline` (Dexie outbox, sync triggers),
  `src/pages`; `e2e/` Playwright.

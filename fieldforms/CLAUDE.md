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

Tests need Postgres on `localhost:5432` with the compose credentials (override with
`TEST_DATABASE_URL` / `E2E_DATABASE_ADMIN_URL`). Playwright uses the Chromium in
`PLAYWRIGHT_BROWSERS_PATH` and is pinned to 1.56.1 to match it.

## Rules that are easy to break

- **Attendance is append-only.** `register_submissions`, `attendance_entries`, `entry_corrections`,
  `audit_log`, `notification_log` and `privacy_requests` have triggers that reject UPDATE/DELETE,
  and the API's DB role (`fieldforms_app`) has no DELETE. Change data by inserting a correction or a
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
- **No `eval`/`new Function`** (ESLint enforces this). The Phase 2 expression engine must parse.

## Layout

- `packages/shared` — zod schemas, time and compliance maths, the sync engine (`src/sync/engine.ts`).
- `apps/api` — Fastify app (`src/app.ts`), routes, services, auth; `src/worker.ts` (pg-boss jobs);
  `src/scripts` (seed, legacy import, create-admin); `test/` (integration, one DB per file).
- `apps/web` — React PWA; `src/sw.ts` (service worker), `src/offline` (Dexie outbox, sync triggers),
  `src/pages`; `e2e/` Playwright.

# FieldForms

In-house mobile forms, starting with staff attendance. FieldForms replaces the Device Magic
platform and the legacy Google Apps Script attendance app at the root of this repository.

- **Supervisors** take the attendance register for their site on a phone: start of shift (present,
  late, absent with replacement), late arrivals, early departures and end of shift, with photos and
  a GPS reading taken at the moment they submit. It works with no signal: registers wait in an
  outbox on the phone and are sent, exactly once, when the phone reconnects.
- **Managers** see a daily report (first in, last out, hours, flags such as missing clock-outs),
  export it to Excel or CSV, add missing clock events and correct records. Every correction needs a
  reason and keeps the original.
- **Admins** manage companies, regions, sites, shifts, employees, users, settings, POPIA requests
  and the audit log.
- **Forms** (inspections, checklists, reports): admins build forms in the browser and publish
  numbered versions. Anyone can fill them in on a phone, offline too, with calculations, show/hide
  rules, photos with markup, signatures, barcode scanning and repeating rows. Managers send a form
  as a pre-filled task to a person or a group, who get it in their inbox and by email.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [TASKS.md](TASKS.md) for the roadmap.

## Quick start (Docker)

```bash
cd fieldforms
docker compose up -d --build
```

Then open <http://localhost:8080>. The first start migrates the database and loads demo data:

| Who                        | Sign in with                                                       |
| -------------------------- | ------------------------------------------------------------------ |
| Admin                      | Office tab · `admin@fieldforms.local` / `fieldforms-dev-admin`     |
| Manager (Delta Facilities) | Office tab · `manager@fieldforms.local` / `fieldforms-dev-manager` |
| Manager (Gauteng only)     | Office tab · `gauteng@fieldforms.local` / `fieldforms-dev-manager` |
| Supervisors (one per site) | Supervisor tab · `S001` … `S008` / PIN `482915`                    |

These credentials are for local use only. Emails (register summaries with PDF) appear in Mailpit at
<http://localhost:8025>.

To test offline behaviour in a desktop browser: sign in as a supervisor, open DevTools → Network,
choose **Offline**, submit a register, then go back **Online** and watch the chip in the header.

The demo data includes a **Site inspection** form, a **Cleaning products** list and a **Gauteng
supervisors** group (S001 and S002). To try forms:

- As a supervisor, open **Forms → Site inspection → Fill in**. The draft is saved on the phone as
  you type; **Submit** puts it in the outbox.
- As the admin, open **Admin → Forms** to edit the form (field list, properties, live preview,
  problems found) and **Publish** a new version. Earlier submissions keep the version they were
  filled in with. **Admin → Lists** takes option lists as CSV: a value and an optional label per row, with an
  optional `value,label` header;
  **Admin → Groups** manages who receives group tasks.
- As a manager, use **Send as task** on the Forms page to dispatch a pre-filled form, **Tasks** to
  follow it up, and **Submissions** to view what came in (photos, markup, signatures, JSON).
  A task for a site only reaches people who can see that site.
- Supervisors sign in with a PIN and need no email address; to email them their tasks, add an
  optional email under **Admin → Users**.

## Development

Requirements: Node 22, pnpm 10 (`corepack enable`), and Docker (for Postgres).

```bash
cd fieldforms
pnpm install
docker compose up -d postgres mailpit         # database and mail catcher only
cp .env.example .env                          # optional; dev defaults work without it

# Database: migrate as the owner, then seed as the app role
MIGRATION_DATABASE_URL=postgres://fieldforms:devpassword@localhost:5432/fieldforms \
APP_DB_PASSWORD=dev-app-password pnpm migrate
DATABASE_URL=postgres://fieldforms_app:dev-app-password@localhost:5432/fieldforms pnpm seed

# Run the API (port 3000), the worker and the web app (port 5173, proxies /api)
export DATABASE_URL=postgres://fieldforms_app:dev-app-password@localhost:5432/fieldforms
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

The Vite dev server does not register the service worker. To try the installable, offline PWA
locally, use `pnpm --filter @fieldforms/web build && pnpm --filter @fieldforms/web preview`
(port 4173, also proxying `/api`).

## Tests

```bash
pnpm test         # unit tests (shared, web) and API integration tests against real Postgres
pnpm e2e          # Playwright: offline acceptance tests on the production PWA build
pnpm typecheck
pnpm lint
```

- API integration tests need a Postgres where the user in `TEST_DATABASE_URL` can create
  databases (default `postgres://fieldforms:devpassword@localhost:5432/postgres`, which matches
  `docker compose up -d postgres`). Each test file gets its own database cloned from a migrated
  template. Tests set the cluster-wide `fieldforms_app` password to `APP_DB_PASSWORD` (default
  `dev-app-password`), the same value the dev setup uses.
- `pnpm e2e` rebuilds a `fieldforms_e2e` database (migrate and seed), starts the API on port 3100
  and `vite preview` on 4173, and runs Chromium with a Pixel 7 profile. Override the database
  server with `E2E_DATABASE_ADMIN_URL`.

## Importing the legacy Google Sheet

1. In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**.
2. Run the importer against the target database:

   ```bash
   # In development
   DATABASE_URL=postgres://fieldforms_app:…@localhost:5432/fieldforms pnpm import-legacy ./export.xlsx

   # Against the running Docker stack
   docker compose cp ./export.xlsx api:/tmp/export.xlsx
   docker compose exec api node dist/import-legacy.js /tmp/export.xlsx
   ```

It prints a reconciliation (rows read, registers imported, rows rejected and why) and is safe to
run again; already-imported registers are skipped. Legacy user accounts are **not** imported,
because their passwords are stored in plain text: create supervisors and PINs in **Admin → Users**.

## Deploying

1. On the server, copy `.env.example` to `.env` and set **every** secret, `PUBLIC_URL`,
   `COOKIE_SECURE=true`, SMTP settings and `SEED_DEMO_DATA=false`.
2. Put HTTPS in front of port 8080 (a reverse proxy, a load balancer or a tunnel). Browsers only
   allow the service worker, camera and GPS on HTTPS.
3. `docker compose up -d --build`. Migrations run automatically before the API starts.
4. With `SEED_DEMO_DATA=false` the database starts empty. Create the first admin (the password
   is read from the environment so it stays out of shell history):

   ```bash
   read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
   docker compose exec -e ADMIN_EMAIL=you@company.co.za -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD \
     api node dist/create-admin.js
   ```

   Running it again for the same email resets that admin's password and unlocks the account.

5. Back up the `pgdata` and `blobs` volumes (or use S3 for photos). Attendance must be kept for at
   least three years (BCEA).

### Single sign-on (managers and admins)

Register an app with Microsoft Entra ID or Google Cloud with the redirect URI
`<PUBLIC_URL>/api/auth/oidc/microsoft/callback` (or `/google/callback`), then set
`OIDC_PROVIDERS` and the matching `OIDC_*` values in `.env`. An admin must first create the user
with their work email; the first SSO sign-in links the account.

## Repository layout

```
apps/api        Fastify API, worker, migrations, seed and legacy importer (TypeScript)
apps/web        React PWA with service worker and IndexedDB outbox; Playwright tests in e2e/
packages/shared Schemas, shift-time and compliance maths, the offline sync engine, the expression
                language (src/expr) and the form definition schema and runtime (src/forms)
docker/         Dockerfiles and nginx config
```

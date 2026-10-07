# FieldForms — Architecture

FieldForms is an in-house replacement for the Device Magic mobile-forms platform and for the
legacy Google Apps Script attendance app that lives at the root of this repository
(`Code.gs`, `attendance.html`, `admin.html`). Attendance comes first; the platform is built so
that inspections, checklists and reports can be added as further forms.

The legacy app stays at the repository root, untouched, so the GitHub Pages staging site keeps
working until cutover. All new code lives under `fieldforms/`.

## Decisions taken with the product owner

| Question                           | Decision                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who records attendance in Phase 1? | **Supervisor register only.** A supervisor records attendance for the employees on a site roster, as the legacy app does. Staff do not log in. Self clock-in can be added later on the same data model. |
| Sign-in                            | **Supervisors:** employee number + PIN. **Managers and Admins:** SSO (Microsoft 365 or Google via generic OIDC), with email + password as a fallback.                                                   |
| Organisation model                 | **Company → Region → Site**, plus shifts per site. Managers and supervisors are scoped to companies, regions or sites.                                                                                  |
| Legacy history                     | **Imported** from an XLSX export of the Google Sheet, tagged `source='legacy'`. The two systems run in parallel until cutover.                                                                          |
| Code location                      | `fieldforms/` in this repo (a pnpm monorepo).                                                                                                                                                           |

## Stack

TypeScript throughout, Node 22, pnpm workspaces.

| Part              | Choice                                                                                                                                       | Why                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`        | React + Vite, `vite-plugin-pwa` (Workbox, injectManifest), Dexie (IndexedDB), TanStack Query, React Router                                   | Installable PWA for Android and iOS; Dexie gives a testable offline outbox                                                      |
| `apps/api`        | Fastify + zod + Kysely (typed SQL) over `pg`                                                                                                 | Schema-first validation; plain SQL migrations stay readable                                                                     |
| Worker            | pg-boss (a job queue stored in Postgres), as a second entry point of `apps/api` (`src/worker.ts`)                                            | No Redis to run; retries, backoff, cron and dead-letter built in; shares the API's DB and storage code                          |
| `packages/shared` | zod schemas, time and compliance helpers, the sync engine                                                                                    | One source of truth for client and server                                                                                       |
| Database          | PostgreSQL 16                                                                                                                                | `timestamptz` everywhere, stored in UTC; shown in `Africa/Johannesburg`                                                         |
| Files             | A Docker volume (default) or any S3-compatible store, behind one `BlobStore` interface                                                       | Images live outside the database. MinIO was planned, but its community images are no longer published, so compose uses a volume |
| Email             | SMTP via nodemailer; Mailpit in development                                                                                                  |                                                                                                                                 |
| PDF               | Gotenberg (headless Chromium in a container)                                                                                                 | Reused by the Phase 3 renderers                                                                                                 |
| Tests             | Vitest for unit tests and API integration tests against a real Postgres; Playwright (Chromium) for end-to-end offline tests                  |                                                                                                                                 |
| Deploy            | `docker compose up`: postgres, migrate and seed (one-shot), api, worker, gotenberg, mailpit, web (nginx serving the PWA and proxying `/api`) |                                                                                                                                 |

## Repository layout

```
fieldforms/
  apps/api/          Fastify API (src/server.ts) and worker (src/worker.ts); src/{routes,services,auth,db};
                     src/scripts/{seed,import-legacy,create-admin}.ts; migrations/*.sql; test/
  apps/web/          React PWA. src/{pages,offline,components,lib}, src/sw.ts, e2e/ (Playwright)
  packages/shared/   schemas, time + compliance maths, sync engine (+ unit tests)
  scripts/           make-icons.mjs
  docker/            Dockerfiles, nginx.conf, security headers
  docker-compose.yml .env.example README.md CLAUDE.md ARCHITECTURE.md TASKS.md
```

## Domain model (Phase 1)

```
companies ─┬─ regions ─┬─ sites ── shifts
           │           │    └── employees (home site)
           │           └── employees in the replacement pool (by region)
users ── user_scopes (company | region | site)
register_submissions ── attendance_entries ── entry_corrections
blobs (photo metadata; bytes in BlobStore)
audit_log, settings, consents, privacy_requests, sessions, notification_log
```

- **companies / regions / sites.** A site has a GPS point, a geofence radius (default 1000 m,
  the legacy value) and optional report recipients. Recipients are set per company (replacing the
  `CompanyEmails` sheet), and a site can override them.
- **shifts.** Each site has named shifts (`day` or `night`) with start and end times. A night
  shift that crosses midnight belongs to the **work date on which it starts**.
- **employees.** People on a roster: employee number, names, title, home site, status
  (`active`/`inactive`), and an optional replacement-pool region. Never hard-deleted.
- **users.** Accounts with a role of `admin`, `manager` or `supervisor`, and scopes.
  - Supervisors sign in with `employee_no` and a PIN hashed with argon2id. Five failed attempts
    lock the account for 15 minutes.
  - Managers and admins sign in with OIDC, or with email and an argon2id password.
  - Admins have global scope. Other users see only the sites their scopes resolve to (a company
    scope covers all its regions and sites).
- **register_submissions.** One supervisor submission:
  - `id` is a UUID generated **on the device**, and is the idempotency key.
  - `kind`: `start` (the morning register), `late` (a late arrival), `left_early`, `end`
    (closing the shift), or `manual` (a manager adding a missing clock event, reason required).
  - site, shift, `work_date`, supervisor, sign-off name.
  - `device_captured_at`, `device_sent_at` and `server_received_at`, plus the derived skew and
    sync-delay values and flags.
  - GPS (lat, lng, accuracy), captured at submit time only, with distance from the site,
    `geo_ok` and `time_ok` (`null` means "could not be determined", never "compliant").
  - Supervisor and staff photo blob ids.
  - `source` (`app` / `legacy` / `seed`) and the raw payload as evidence.
- **attendance_entries.** One row per employee per submission: `status`
  (`present`/`late`/`absent`/`left_early`), `event` (`in`/`out`, or none for absent), `event_at`,
  minutes late or early, reason, and replacement employee.
- **entry_corrections.** Append-only. Each correction stores the full set of correctable values
  before and after, a **required reason**, who made it and when. Originals are never updated.
  The view `attendance_entries_effective` applies the most recent correction.
- **audit_log.** Append-only: who, what, which entity, IP, user agent, when, details. Covers
  sign-ins, writes, corrections, exports, privacy actions, and **every view of attendance data**.

### Immutability is enforced by the database

- Triggers reject `UPDATE` and `DELETE` on `register_submissions`, `attendance_entries`,
  `entry_corrections` and `audit_log`.
- The API connects as `fieldforms_app`, which does not own the tables (so it cannot drop the
  triggers) and has no `DELETE` or `TRUNCATE` grant except on `sessions`.
- Migrations run as the database owner.

## Timestamps and the clock-skew flag

All timestamps are stored as `timestamptz` (UTC) and shown in `Africa/Johannesburg`.

Comparing the device timestamp with the server-received timestamp alone would flag every record
captured offline, because sync lag is legitimate. So the device sends both
`device_captured_at` (when the register was submitted) and `device_sent_at` (stamped on each
upload attempt), and the server derives:

- **Clock skew** = `server_received_at − device_sent_at`. Flagged when its absolute value
  exceeds `clock_skew_threshold_seconds` (default 120). This catches phones whose clock is wrong
  or has been changed.
- **Sync delay** = `device_sent_at − device_captured_at`, both on the device's own clock so a wrong
  clock is not counted twice. Stored and shown; flagged only above `sync_delay_flag_hours`
  (default 24).

Both thresholds are admin settings.

## Offline and sync

1. The service worker precaches the app shell. After each online sign-in or refresh, the
   supervisor's sites, shifts, roster and replacement pool are cached in IndexedDB.
2. Submitting writes the register to the IndexedDB **outbox** with a client UUID. Photos are
   compressed on the device (JPEG, longest side 1600 px) and stored as Blobs in the same
   transaction. GPS is read at this moment only.
3. The sync engine (`packages/shared/src/sync`) is a pure state machine with an injectable store,
   transport and clock, so it is unit-tested without a browser:
   1. `PUT /api/blobs/:id` for each photo (idempotent; a different body for the same id is a 409).
   2. `POST /api/registers` with the client UUID. The server inserts with
      `ON CONFLICT (id) DO NOTHING` and returns the stored record in either case.
   3. The item is marked `synced`.
4. Retries use exponential backoff with equal jitter (2 s doubling, capped at 15 min) for server
   trouble. No attempt is made while the phone reports no connection, and when connectivity
   returns (or the user taps _Sync now_) pending items are retried at once rather than waiting out
   the backoff. Sync runs on `online` events, on app open and visibility change, every 30 s, after
   each new capture, and through Background Sync on Android (iOS has none, so it syncs next time
   the app is open).
   Items are claimed with a 30-second lease, so a tab and the service worker do not send the same
   item together, and an upload cut off by closing the app is picked up again once the lease lapses.
5. Errors are classed as retryable (network, 5xx, 429), auth (401: items stay queued and the app
   asks for the PIN again) or permanent (4xx validation: the item is parked as `failed` with the
   reason and can be retried manually). Nothing is ever dropped silently.
6. A status chip shows Pending, Syncing, Synced or Failed counts.
7. Each item records the user who captured it, and only that user's session sends it, so a
   register captured on a shared phone is never uploaded under someone else's name.

The session cookie has a 30-day sliding expiry, so a supervisor who signed in online can keep
capturing registers offline.

## API (Phase 1)

All routes are under `/api`. Every route checks role and scope on the server. Mutating requests
must carry the `X-FieldForms: 1` header; browsers cannot add it cross-site without a CORS
preflight, which the API never grants, so this blocks CSRF alongside `SameSite=Lax` cookies.

| Route                                                                                                                                          | Who                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `POST /auth/pin`, `POST /auth/password`, `GET /auth/oidc/:provider/start`, `GET /auth/oidc/:provider/callback`, `POST /auth/logout`, `GET /me` | anyone / signed in                 |
| `POST /consent`                                                                                                                                | signed in                          |
| `GET /sync/bootstrap` (sites, shifts, roster, pool, settings for the user's scope)                                                             | supervisor+                        |
| `PUT /blobs/:id`, `GET /blobs/:id`                                                                                                             | supervisor+ (scoped)               |
| `POST /registers`, `GET /registers`, `GET /registers/:id`                                                                                      | supervisor (own scope) / manager+  |
| `POST /entries/:id/corrections`, `POST /registers/manual`                                                                                      | manager+ (scoped), reason required |
| `GET /reports/daily`, `GET /reports/daily/export.xlsx`, `.csv`                                                                                 | manager+ (scoped)                  |
| `/admin/*` CRUD for companies, regions, sites, shifts, employees, users, settings                                                              | admin                              |
| `GET /admin/audit`, `GET /admin/retention`, `/privacy/*`                                                                                       | admin                              |
| `GET /health`                                                                                                                                  | anyone                             |

Rate limits apply to all routes, with a stricter limit on `/auth/*`. Security headers come from
`@fastify/helmet`.

## Daily report

One row per employee per work date in the filter:

- first IN, last OUT and hours worked (last OUT − first IN)
- status (present, late, absent, left early), minutes late or early, reason, replacement
- flags: **missing IN** (an OUT without an IN), **missing OUT** (an IN with no OUT once the shift
  has ended), absent, late, left early, clock skew, sync delay, outside geofence, outside the shift
  time window, corrected

The report reads `attendance_entries_effective`, so corrections show while the originals stay
intact. Viewing and exporting (XLSX via exceljs, CSV with formula-injection escaping) are
audit-logged.

## Notifications (parity with the legacy app)

After a `start` or `end` register is stored, the API enqueues a `register.notify` pg-boss job keyed
by the submission id. The worker renders the HTML summary, asks Gotenberg for a PDF, and emails the
site's recipients. A `notification_log` row makes delivery idempotent, and a sweeper re-enqueues
anything missed. If Gotenberg is unavailable the email goes without the PDF, and that is logged.
This is a single-destination version of the Phase 3 destinations system.

## Compliance and security

- **BCEA.** Attendance is kept for at least 3 years from an employee's last entry. Admins can set a
  longer period but not a shorter one. `GET /admin/retention` lists employees past retention for
  review. Nothing is deleted automatically.
- **POPIA.**
  - Minimal data: no ID numbers, no home addresses, no biometrics. Photos are register evidence
    and are not processed further.
  - GPS is read only when a register is submitted, never in the background.
  - A notice and consent screen is shown on first sign-in and whenever the notice version
    changes; consent is recorded with its version and time.
  - Retention is configurable within the BCEA minimum.
  - Access requests export everything held on an employee as JSON. Deletion requests anonymise the
    employee's personal fields once retention has passed, and are refused with a logged reason
    while BCEA retention applies.
  - Every view of attendance data is audit-logged.
- **Security.** Private by default (every route requires a session except sign-in and health),
  per-role and per-scope checks, rate limiting, argon2id hashes, httpOnly cookies, and no secrets
  in the repo (`.env.example` only). Destination secrets in Phase 3 will be encrypted with
  AES-256-GCM using a key from the environment.

## Legacy import

`scripts/import-legacy.ts` reads an XLSX export of the legacy Google Sheet:

- `Employees`, `ReplacementPool`, `SiteLocations`, `CompanyEmails` → master data. Legacy rows have
  no employee number, so the importer assigns `LEG-nnnn` and matches attendance by name, only
  within the same site or that region's replacement pool (two people with the same name at
  different sites stay separate).
- Legacy shift times become history-only shifts, created deactivated so they do not appear in
  supervisors' pickers.
- `Attendance` (the 30 columns in `ATTENDANCE_HEADERS`, `Code.gs:204`) → rows grouped by
  `SubmissionID` into `register_submissions` and `attendance_entries` with `source='legacy'`.
- Re-running is safe: submissions already imported are skipped.
- It prints a reconciliation (rows read, imported, skipped, rejected with reasons).
- Legacy plain-text passwords are **not** imported. Supervisors are given new PINs.

## Phase 2: forms

Attendance stays as it is: a purpose-built register with its own tables and report. Phase 2 adds a
general form engine beside it for inspections, checklists and reports.

### Definitions and versions

- A **form** has an editable **draft definition** (JSON) and a list of **published versions**.
  Publishing validates the draft strictly and copies it into `form_versions` with the next
  version number. Published versions are append-only (database trigger), so a submission always
  points at exactly the definition it was filled in with (`form_submissions.form_version_id`).
- A definition is plain JSON, validated by zod in `packages/shared/src/forms`:

  ```json
  {
    "schemaVersion": 1,
    "title": "Site inspection",
    "settings": { "siteRequired": true },
    "fields": [
      {
        "id": "area",
        "type": "select",
        "label": "Area",
        "required": true,
        "options": { "source": "list", "listId": "…" }
      },
      {
        "id": "items",
        "type": "group",
        "label": "Items",
        "minRows": 1,
        "fields": [
          { "id": "qty", "type": "number", "label": "Qty", "min": 0 },
          { "id": "price", "type": "number", "label": "Price" },
          {
            "id": "line_total",
            "type": "calculated",
            "label": "Total",
            "expression": "qty * price"
          }
        ]
      },
      {
        "id": "grand_total",
        "type": "calculated",
        "label": "Grand total",
        "expression": "ROUND(SUM(items.line_total), 2)"
      },
      {
        "id": "fault_photo",
        "type": "image",
        "label": "Photo of the fault",
        "annotate": true,
        "visibleIf": "grand_total > 1000"
      }
    ]
  }
  ```

- **Field types:** `text`, `number`, `select` and `multiselect` (options inline, or from a managed
  list that can be loaded from CSV), `date`, `time`, `datetime`, `calculated`, `geotag`, `image`
  (with an annotation layer), `signature`, `barcode` (QR and 1D), `group` (repeating rows) and
  `note` (instructions, no value).
- Every field can have `required` (true or an expression), `visibleIf` (an expression) and
  `validations` (expressions with messages). Hidden fields are not required, are not validated,
  and their values are dropped on submit.
- Field ids are unique within their scope (the form, or one repeat group). Publishing checks that
  every expression parses, refers only to existing fields, and that calculated fields do not
  depend on each other in a cycle.

### Expression language

A small spreadsheet-like language, parsed (tokenizer + Pratt parser → AST) and evaluated by walking
the tree. There is no `eval` or `new Function` anywhere, and nothing in an expression can reach
JavaScript objects: identifiers only resolve to form values, and functions come from a fixed table.

- **Values:** numbers, text (`"…"` or `'…'`), `TRUE`/`FALSE`, `NULL`, and lists (a repeat group
  column or a multi-select).
- **Operators:** `+ - * / %`, comparison `= <> != < <= > >=`, `AND OR NOT`, `&` for joining
  text, and parentheses.
- **References:** a field id (`qty`). Inside a repeat group, a sibling field in the same row
  wins over a form-level field; `group.field` gives the whole column as a list.
- **Functions:** `IF`, `AND`, `OR`, `NOT`, `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `ROUND`, `FLOOR`,
  `CEIL`, `ABS`, `CONCAT`, `LEN`, `UPPER`, `LOWER`, `TRIM`, `ISBLANK`, `COALESCE`, `CONTAINS`,
  `TODAY`, `NOW`, `DATEDIFF(end, start, "days"|"hours"|"minutes")`, `DATEADD`, `YEAR`, `MONTH`,
  `DAY`.
- **Errors never throw out of the evaluator:** a bad value (text in arithmetic, division by zero)
  evaluates to blank with an error message for the builder to show. Limits on expression length,
  nesting depth and evaluation steps keep a hostile expression from hanging a phone or the API.
- The same engine runs in the browser (live calculation, show/hide) and on the server, which
  re-evaluates every submission and stores its own computed values.

### Submissions, drafts and offline

- `form_submissions` is append-only and keyed by a UUID made on the device (idempotent, like
  registers). It stores the answers as JSON, the site, the device and server timestamps with the
  same clock flags as registers, and the photos and signatures as blob ids
  (`form_submission_files`), which also decide who may view them.
- The Phase 1 outbox and sync engine carry form submissions too (`type: 'form'`), with the same
  retry, backoff and status chip. Photos are compressed on the device; an annotated photo is
  stored as the untouched original plus a separate transparent annotation layer.
- Drafts are saved on the phone as you type (IndexedDB) and can be resumed or discarded.
- The offline bootstrap now also downloads the published forms the user may fill in, the option
  lists they use, and the user's inbox.

### Dispatch

- A manager or admin dispatches a form to **a user or a group** (`user_groups`), optionally for
  a site, with a due date and pre-filled answers. The form version is fixed at dispatch time.
- It appears in the assignee's inbox (offline too). For a group, whoever submits first completes
  it for everyone. Dispatches can be cancelled; they are never deleted.
- A task for a site only reaches people whose scope covers that site, because nobody else could
  submit it. Groups may span sites: members without access to the task's site do not see it and
  are not emailed, and dispatching to a user (or a group with no member) who cannot see the site
  is refused.
- The worker emails each assignee who has an email address. Supervisors may now have an optional
  email for this; they still sign in with employee number and PIN.

### Who can do what

| Action                                           | Admin | Manager                              | Supervisor |
| ------------------------------------------------ | ----- | ------------------------------------ | ---------- |
| Build and publish forms, manage lists and groups | yes   |                                      |            |
| Fill in published forms                          | yes   | yes                                  | yes        |
| Dispatch forms                                   | yes   | yes (to users and groups)            |            |
| View submissions                                 | all   | sites in scope, and their dispatches | their own  |

## Later phases (summary)

- **Phase 3: outputs and destinations.** PDF, DOCX, XLSX, JSON, XML and image renderers from
  branded templates; a `DestinationAdapter` interface with per-form destinations, rules, a
  delivery log, retries, a dead-letter queue and redelivery; a REST API with API keys.
- **Phase 4: dashboards.** A chart builder over form fields and a preset attendance dashboard.

## Changes from the approved plan

- The worker is a second entry point of `apps/api` rather than its own package, so it shares the
  database, storage and rendering code without a third build.
- Compose stores photos on a Docker volume instead of MinIO (no MinIO images are published any
  more). The S3 driver is still there for production.
- Seed, legacy import and create-admin scripts live in `apps/api/src/scripts` so they ship in the
  API image.
- Sync delay is measured on the device clock (see above).
- Phase 2 does **not** re-express the attendance register as a form definition. The register
  needs a per-site roster, replacements, shift-time maths, per-employee rows that managers correct
  one by one, and its own report; as a generic form it would lose those or need special cases in
  the form engine. Both share the outbox, sync engine, photo store and clock flags instead.

See `TASKS.md` for the phased task list and status.

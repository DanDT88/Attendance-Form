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

## Phase 3: outputs and destinations

Every form submission can be turned into documents (PDF, Word, Excel, JSON, XML, photos) and
delivered automatically to any number of destinations per form: email, webhook, SFTP, S3, Google
Drive, OneDrive/SharePoint, Slack, a SQL table (PostgreSQL or SQL Server) or a Google Sheet.
Other systems can also pull data through a REST API with API keys. Attendance registers keep
their Phase 1 email summary; they are not a destination source yet.

This design was reviewed before it was built by four independent critics (security,
reliability, product, fit with the code). Their findings are folded in below; the main ones
are noted where they changed the design.

```
form_submissions INSERT ─(same transaction)─► plan-deliveries job
plan: delivery_plans marker + deliveries rows (one per matching destination) + deliver jobs
deliver: claim the row (lease) ─► render (cached) ─► adapter ─► finish (attempt row + new state)
                                    └─ retry: back to pending with next_attempt_at, new job
sweeper: unplanned submissions, overdue pending rows, expired leases    alerts: one per incident
```

### One vocabulary for templates, conditions and mappings

Field ids are used as they are, and everything else starts with `_` (field ids start with a
letter, so the two never clash). In a **template**, `{{ area }}` is the display text (option
labels, formatted dates and locations); in a **condition or column mapping**, `area` is the raw
value. A repeat group is a list of rows in both. A field that the submission's form version does
not have is blank (NULL), never an error, because submissions keep arriving on older versions.

| Name                     | Meaning                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `_id`, `_short_id`       | Submission id, and its first 8 characters (for unique file names)                                          |
| `_form`, `_version`      | Form name and version number                                                                               |
| `_site`, `_site_id`      | Site name and id (the id survives renames)                                                                 |
| `_region`, `_company`    | Region and company names                                                                                   |
| `_submitted_by`, `_task` | Who submitted it (blank unless the destination includes it); task title                                    |
| `_captured`, `_received` | When it was filled in (device time, or the server's if the device clock was off) and when it arrived, SAST |
| `_url`                   | Link to the submission in FieldForms (sign-in required)                                                    |
| `_fields`, `_branding`   | Templates only: every field in order (for generic layouts); logo, colour, name, footer                     |

### Documents

- **Formats:** `pdf`, `docx`, `xlsx`, `json`, `xml` and `images` (each photo with its markup
  composited, the original only if the destination includes originals, and signatures as PNG;
  downloaded from the app as one ZIP). JSON and XML hold the answers and submission metadata,
  never the device payload or clock evidence.
- **Default layouts** (no template): a branded PDF, Word and Excel document generated from the
  fields: header with logo and colour, label/answer table, a table per repeat group (a sheet each
  in Excel), photos and signatures.
- **Templates:** `html` (Liquid, for PDF) and `docx` (Word, for Word **or PDF**). Word becomes
  PDF through Gotenberg's LibreOffice route, so office staff can design branded PDFs in Word.
  Word templates use `{{ }}` placeholders, `{{#items}}…{{/items}}` loops over repeat groups and
  conditional sections, and `{{%photo_field}}` for photos (a small in-house image module that only
  takes images from the document model; the free one is unmaintained and depends on a
  vulnerable XML library). The parser resolves names only (no expressions) and refuses raw-XML
  tags. Excel templates are deferred: exceljs drops charts and images and does not move them
  when it repeats rows, so Excel output uses the built-in layout.
- **Templates are linked to forms** and checked when saved: placeholders are extracted (Liquid
  variables, the Word tags) and compared with every published version of the
  linked forms, so a typo or a field missing from some version is reported then, not discovered
  in a client's document. Blank values print as nothing (never "undefined"). A **starter
  template** with every field, loop and photo tag can be downloaded per form, and a **preview**
  renders a template against a chosen submission or a sample without sending anything (audited,
  since it shows submission data).
- **Versioned:** saving a template creates an immutable version; each delivery attempt records
  the versions it used. Each form can name a default template per format for in-app downloads.
- **The model holds no image bytes.** `buildDocumentModel` (pure, in `packages/shared`) turns a
  version's definition, the stored answers and the submission's metadata into the model, with
  photos and signatures as references. Renderers that need pixels (PDF, Word, images) load them
  through a media loader that composites the markup layer with sharp, caches per delivery, embeds
  at most about 60 images at 1024 px per document, and uses 1600 px for the images format.
- **JSON** is `{ schema: "fieldforms.submission/1", form, submission, answers, files }` (files
  are references with API URLs), the same body as `GET /api/v1/submissions/:id`. **XML** uses
  `<field id="qty" type="number">` elements, never field ids as element names.
- **Rendered once:** a document is rendered once per submission, format, template version and
  include settings, stored in the blob store and reused by every destination and retry.
- **Which process does what:** the API renders in-app downloads and previews (it can reach
  Gotenberg) and seals secrets; the worker delivers, checks connections and runs test sends, the
  only things that need secrets. Both build their renderers and adapters from one factory.
- **Renderer isolation:** Gotenberg runs on an internal Docker network with no route out, with
  basic auth, JavaScript off, Chromium limited to its own temporary files and data: URIs, and the
  LibreOffice download and webhook features off. Generated HTML gets a strict CSP, the renderer
  owns the `<head>` (templates cannot add `<meta>` or `<base>`), images are embedded as data URIs,
  and Word/Excel templates with external links (linked images, remote fields) are refused.
- **Branding:** companies have an optional logo, colour and document footer; submissions without
  a site use the defaults in settings (`brandName`, `brandColour`).

### Connections

Credentials are stored once, as a **connection**, and shared by the destinations that use them
(an Entra client secret that expires is changed in one place). Kinds: `webhook`, `sftp`, `s3`,
`google` (a service account, for Drive and Sheets), `microsoft` (an Entra app, for OneDrive and
SharePoint), `slack` and `sql` (PostgreSQL or SQL Server). Email uses the server's SMTP settings
and needs no connection.

- A connection has non-secret settings, **sealed secrets** (see Secrets), the result of its last
  check and an optional secret expiry date (alerted 30 days ahead). Changes are versioned
  (`connection_revisions`, without secret values).
- **Binding fields:** changing where a connection points (webhook URL, SFTP host/port/user/host
  key, S3 endpoint/region, SQL server, tenant/client) clears its secrets, so a stored password can
  never be sent to a new server by editing the host.
- **Check connection** is read-only where possible and works on unsaved settings with secrets
  typed in the same request: Google shows the service account's email to share with and reads
  the folder or sheet; Microsoft resolves the site and library to a drive; S3 heads the bucket;
  SQL reads the table's columns and confirms the unique index; SFTP shows the host key to pin;
  a webhook gets a signed `ping`; Slack gets a "FieldForms connected" message.

### Destinations

A destination belongs to one form: a name, a kind, its connection, one or more **formats**
(each with an optional template), an optional **condition**, the per-form settings of its kind,
what it may **include**, and an active switch. Changes are versioned (`destination_revisions`)
and audited; destinations are archived, never deleted.

- **Include (POPIA):** an allowlist of fields (default: every field that is not a photo,
  signature or location), photos (none, marked-up only, or with originals; default marked-up),
  signatures, location (none, rounded to ~1 km, exact; default none) and the submitter's name.
  The document model is filtered before rendering, so templates cannot reach anything excluded.
  Each destination also names the **recipient** organisation and whether data leaves South
  Africa; sending personal fields across the border needs an explicit, audited confirmation.
- **Conditions and mappings** are checked when saved against the draft and every published
  version of the form, with warnings for fields some versions lack. Publishing a new version
  re-checks the form's destinations and templates and shows the publisher what changed.

| Kind            | Per-form settings                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`         | Recipients from any of: fixed addresses, form fields, the site's report recipients (else the company's, as in Phase 1), the submitter, the task's sender, managers covering the site. Reply-To, subject, message. No recipient → skipped. |
| `webhook`       | Include documents (base64) or JSON only                                                                                                                                                                                                   |
| `sftp`          | Folder and file-name templates                                                                                                                                                                                                            |
| `s3`            | Bucket, key prefix and file-name templates                                                                                                                                                                                                |
| `google_drive`  | Shared Drive folder and file-name templates (service accounts have no My Drive quota; the check explains this)                                                                                                                            |
| `onedrive`      | SharePoint site URL and library, or a user; folder and file-name templates                                                                                                                                                                |
| `slack`         | Message template (form, site, time and an in-app link only)                                                                                                                                                                               |
| `sql`           | Table, column mappings, key column, insert-only or upsert                                                                                                                                                                                 |
| `google_sheets` | Spreadsheet, sheet, column mappings; header row written when the sheet is empty                                                                                                                                                           |

- **File names:** the default is `{{ _form }} - {{ _site }} - {{ _captured }} - {{ _short_id }}`
  (unique per submission and filed by when the work was done). Saving warns if a name template
  has no `_short_id` or `_id`. Folder templates may use `/` (each segment cleaned), e.g.
  `{{ _company }}/{{ _site }}/{{ _captured | date: "%Y-%m" }}`, and missing folders are created.
  A file is never silently replaced by another submission's: uploads are created with a
  no-overwrite condition and tagged with the delivery id; an existing file is replaced only if it
  carries the same delivery id (a retry or resend), otherwise the delivery fails with "name
  already used by another submission".
- **Column mappings** default to picking a field (written as display text: labels, SAST dates,
  `_url` links for photos) with an expression mode for advanced use. `rowsFrom` writes one row
  per repeat-group row. Sheets values are written `USER_ENTERED` with text that starts with
  `= + - @` or a tab escaped by a leading apostrophe, so dates and numbers are typed but nothing
  runs as a formula. SQL requires a unique index on the key column mapped from `_id` (checked),
  binds every value as a parameter, quotes identifiers, and verifies TLS by default.

### Delivery pipeline

The `deliveries` row is the state machine and the lock; pg-boss only wakes workers up. (pg-boss
10 does not enforce `singletonKey` on standard queues, cannot cancel a handler that overruns, and
cannot fail a job permanently, so it cannot own these guarantees.)

- **Planning** happens in one transaction, enqueued from `createFormSubmission`'s own
  transaction: insert the `delivery_plans` marker first (a concurrent planner waits on it, then
  exits), then the deliveries (`ON CONFLICT DO NOTHING`), then one `deliver` job per inserted row
  through pg-boss's `db` option, so jobs and rows commit together. A destination is used if it is
  active at planning time and existed when the submission arrived. Conditions are evaluated on
  the submission's own version: false → `skipped`; a runtime error → `failed`.
- **Delivering:** a job carries `{deliveryId, generation}`. The worker claims the row
  (`pending → sending` with a lease token, only if the generation matches and it is due), checks
  the destination is still active (else `cancelled`), fixes the target and template versions for
  the generation on the first attempt, renders, and calls the adapter with a deadline. It then
  finishes in one transaction guarded by the lease token: an attempt row, and `delivered`,
  `failed`, or back to `pending` with the next attempt time and a new job.
- **Retries** stretch over about a day (30 s doubling, each wait capped at an hour), so a power
  cut at an on-premises server does not exhaust them. Permanent errors stop at once. The deliver
  queue has `retryLimit: 0` (the row decides), each worker runs several deliver loops, and every
  adapter call has a deadline well inside the lease and the job's expiry.

| Error                                                                                                                                                                               | Class     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Network failure, timeout, HTTP 408/429/5xx, SMTP 4xx, Gotenberg down                                                                                                                | retry     |
| HTTP 4xx, SMTP 5xx (incl. too large), authentication, host-key mismatch, address not allowed, missing folder/table, template error, secrets that cannot be opened, invalid settings | permanent |

- **Sweeper** (every few minutes): plans submissions with no marker after 2 minutes; re-enqueues
  pending rows more than 5 minutes overdue; returns `sending` rows whose lease expired to
  `pending` with an `abandoned` attempt (the outcome is unknown and is shown as such).
- **Incidents and alerts:** failures are tracked per destination (`failing_since`, consecutive
  failures, last success). The first failure of an incident sends one alert (form, destination,
  error, count, link); later ones only raise the count; a reminder goes daily while it lasts and
  a "recovered" note on the next success. Alerts go to `deliveryAlertEmails`, else active admins
  with an email. Phase 1 register and task emails that give up are included in the same alerts
  and listed on the same page.
- **Deliveries page:** filter by status, form, destination and date, grouped by error, with each
  destination's last success and recent failures, and bulk resend. Managers see the deliveries
  of submissions they can view, with plain-language errors (admins also see the redacted detail).
- **Retry, resend, backfill:**
  - _Retry now_ brings a pending delivery's next attempt forward.
  - _Resend_ (admins, and managers for submissions they can view) starts a new generation with
    the destination's current settings and templates: a new idempotency key
    (`<delivery id>.<generation>`, plus `X-FieldForms-Resend: 1` for webhooks), and file
    destinations replace the earlier file of the same delivery. A skipped delivery can be
    re-checked against its condition and sent.
  - _Send to destination_ creates missing deliveries for a selection or date range of
    submissions (capped, audited); creating or re-activating a destination offers the same for
    submissions since a date.
  - Deactivating a destination cancels its pending deliveries.
- **Test send** runs a destination on a sample (values generated from the form, with placeholder
  photos) or, as an explicit audited choice, a chosen submission, without recording a delivery: email goes only to the admin running it with `[TEST]` in the subject, files get a
  `TEST ` prefix, webhooks carry `X-FieldForms-Test: 1`, SQL runs in a rolled-back transaction,
  and Sheets appends only if asked. Tests and checks run in the worker (only it can open
  secrets); the screen polls for the result.
- **The delivery log** records, per attempt: generation, destination and connection revisions,
  template versions, each document's name, type, size and SHA-256, the resolved target without
  secrets (recipients, URL origin and path, bucket and key, remote path, table, sheet), the
  destination's evidence (SMTP message id and reply, HTTP status, ETag, file id), job id, worker,
  times and outcome. An SMTP 250 means the relay accepted the message, not that it was read.

### Errors never leak secrets

Adapters throw `DeliveryError` with a message from a fixed vocabulary ("Receiver returned HTTP
401", "SFTP authentication failed", "Address not allowed") and an internal detail that is
redacted (secret values and their encodings, URL credentials and query strings) and capped
before it is stored. Response bodies and raw socket errors are never stored. The deliver job
never passes an adapter's error to pg-boss, so job rows hold ids and safe text only.

### Outbound network and transport security

URLs and hosts that admins configure may reach only public unicast addresses, plus private
ranges listed in `DESTINATIONS_ALLOWED_PRIVATE_CIDRS`. Link-local (cloud metadata), multicast,
reserved and unspecified addresses are never reachable, nor is the server's own network (the
Docker network with Postgres and Gotenberg) unless `DESTINATIONS_ALLOW_SAME_NETWORK` is set for
development. Addresses embedding IPv4 (mapped, NAT64, 6to4) are judged by the IPv4 inside. The
check runs on the address actually connected to: a guarded DNS lookup for fetch and the S3
client, a pre-resolved IP (with the TLS server name) for SFTP and SQL. Redirects are not
followed. TLS is required: https only (plain http only to listed private ranges), SQL verifies
certificates unless switched off for a private range, and SMTP requires STARTTLS
(`SMTP_REQUIRE_TLS`, off only for the development mail catcher). Vendor endpoints are fixed:
Google's token endpoint ignores `token_uri` in the key file, Slack URLs must be
`https://hooks.slack.com/…`, and Microsoft endpoints are fixed.

### Secrets

Secrets are **sealed to the worker**: the internet-facing API holds only an X25519 public key
(`SECRETS_PUBLIC_KEY`) and can seal what an admin types but never open a stored secret; the
worker holds the private key (`SECRETS_PRIVATE_KEY`). Each value is sealed with an ephemeral
key (ECDH, HKDF-SHA256, AES-256-GCM) and bound to its row as associated data, so a sealed value
copied onto another row does not open. `SECRETS_PRIVATE_KEY_PREVIOUS` allows a rotation and a
script re-seals everything. The API reports only which secrets are set; saving without one keeps
it (unless a binding field changed). Least-privilege setup is documented per kind (Graph
`Sites.Selected`, a Google service account with only the target folder shared, an S3 key limited
to one prefix, a SQL user with INSERT on one table).

### Public REST API

- **API keys** (`ff_<prefix>_<secret>`, 32 random bytes) are stored as a SHA-256 hash and shown
  once. A key has a name, scopes, a site scope (companies, regions or sites, or all sites), an
  optional list of forms, an optional expiry and a last-used time, and can be revoked. Key
  changes are audited.
- A key sees what a manager with the same site scope would, except that **siteless submissions
  and tasks are visible only to all-sites keys**.
- `/api/v1` is a separate scope that accepts only `Authorization: Bearer` keys (no cookies, so
  no CSRF guard), with a rate limit per key and a per-IP limit on failed key lookups.
- **Scopes and endpoints:**
  - `forms:read`: `GET /api/v1/forms`, `GET /api/v1/forms/:id/versions/:version`
  - `submissions:read`: `GET /api/v1/submissions` (filters, cursor pagination),
    `GET /api/v1/submissions/:id`, `GET /api/v1/submissions/:id/document?format=`
  - `files:read`: `GET /api/v1/files/:id` (photos and signatures of submissions it can see)
  - `attendance:read`: `GET /api/v1/attendance/daily` (the daily report rows)
- Every read is audited against the key (`audit_log.actor_api_key_id`). The pull model (poll
  `/api/v1/submissions` with a cursor) is the recommended route for on-premises systems, since it
  needs no inbound firewall rule; an example sync script is included. An OpenAPI 3.1 document is
  served at `/api/v1/openapi.json`.

### Who can do what (Phase 3)

| Action                                                               | Admin | Manager                   | Supervisor |
| -------------------------------------------------------------------- | ----- | ------------------------- | ---------- |
| Connections, destinations, templates, branding, API keys, backfill   | yes   |                           |            |
| See deliveries; resend or retry a delivery                           | all   | submissions they can view |            |
| Download a submission as PDF, Word, Excel, JSON, XML or photos (ZIP) | all   | submissions they can view | their own  |

Managers see a delivery's destination, status, time and a plain-language error, never settings
or technical detail.

### Not in Phase 3

Attendance registers as a destination source; Excel templates; creating tasks through the API
(`dispatches:write`); MySQL; Slack file uploads; inbound webhooks; personal Google accounts
(Drive needs Google Workspace Shared Drives).

## Later phases (summary)

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

- Phase 3 defers Excel templates (Excel output uses the built-in layout) and creating tasks
  through the public API; adds SQL Server beside PostgreSQL for the SQL destination; and adds
  shared connections, so credentials are entered once and sealed to the worker.

See `TASKS.md` for the phased task list and status.

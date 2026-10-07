# Phase 3 HTTP API (contract)

The routes the Phase 3 admin screens, the delivery log and other systems use. Shapes are JSON
unless stated. Field names in bodies are camelCase; rows returned straight from the database
keep snake_case, as the Phase 1 and 2 routes do. Every mutating `/api` route needs the
`x-fieldforms: 1` header (CSRF guard). Validation errors are `400 { error, details }`;
anything outside the caller's role or scope is `403` (or `404` where existence must not leak).
Types and schemas are in `packages/shared/src/outputs.ts`.

## Connections (admin)

| Route                                   | Body / query                                                                                                          | Returns                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/connections`            | `?kind=`                                                                                                              | `[{ id, name, kind, config, secretKeys, secretExpiresOn, lastCheck: { at, ok, detail } \| null, destinations: number, archivedAt }]`           |
| `POST /api/admin/connections`           | `{ name, kind, config, secrets: { [key]: string }, secretExpiresOn? }`                                                | `201 { id, generated?: { signingSecret } }` (a webhook signing secret left empty is generated and shown once)                                  |
| `GET /api/admin/connections/:id`        |                                                                                                                       | the list row plus `revisions: [{ revision, createdAt, createdBy, secretsReset }]`                                                              |
| `PATCH /api/admin/connections/:id`      | `{ name?, config?, secrets?, secretExpiresOn?, archived? }`. A secret key with `""` clears it; omitted keys are kept. | `{ secretsReset: boolean }` (true when a binding field changed: all secrets were cleared and must be re-entered)                               |
| `POST /api/admin/connections/:id/check` | `{}`                                                                                                                  | `202 { testId }`                                                                                                                               |
| `POST /api/admin/connection-checks`     | `{ kind, config, secrets }` (unsaved; secrets sealed to the test row)                                                 | `202 { testId }`                                                                                                                               |
| `GET /api/admin/tests/:id`              |                                                                                                                       | `{ id, kind, status: queued\|running\|ok\|failed, result: { summary, facts?, warnings?, target?, evidence? } \| null, createdAt, finishedAt }` |

Secrets are validated with the connection driver's `secretSchema`, sealed with `deps.sealer`
(AAD `connection:<id>`), and never returned. Changing a field listed in
`CONNECTION_BINDING_FIELDS[kind]` clears `secrets` and `secret_keys` unless new secrets come in
the same request. Every change adds a `connection_revisions` row and an audit row (no secret
values, ever).

An unsaved SFTP check (`POST /api/admin/connection-checks`) accepts an empty or missing
`hostKeySha256`, so an admin can learn the fingerprint first: the check connects, refuses to log
in to an unpinned host and reports the presented key in `result.facts.hostKeySha256`. Saving a
connection still requires the fingerprint.

## Destinations (admin)

| Route                                            | Body / query                                                                                                                                                                                 | Returns                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/forms/:formId/destinations`      |                                                                                                                                                                                              | `[{ id, name, kind, connectionId, connectionName, formats, templates, condition, settings, include, recipient, crossBorder, active, revision, health: { failingSince, consecutiveFailures, lastSuccessAt, lastFailureAt, last24h: { delivered, failed, pending } }, archivedAt }]` |
| `POST /api/admin/forms/:formId/destinations`     | `{ name, kind, connectionId?, formats: Format[], templates: { [format]: templateId }, condition?, settings, include, recipient?, crossBorder, confirmCrossBorder?, active, backfillSince? }` | `201 { id, warnings: string[], backfilled?: { created, skipped, existing } }`                                                                                                                                                                                                      |
| `GET /api/admin/destinations/:id`                |                                                                                                                                                                                              | the list row plus `revisions: [{ revision, createdAt, createdBy }]`                                                                                                                                                                                                                |
| `PATCH /api/admin/destinations/:id`              | any of the POST fields, plus `backfillSince?` when re-activating                                                                                                                             | `{ warnings, cancelled?: number, backfilled? }`                                                                                                                                                                                                                                    |
| `POST /api/admin/destinations/:id/archive`       |                                                                                                                                                                                              | `{ cancelled: number }`                                                                                                                                                                                                                                                            |
| `POST /api/admin/destinations/:id/check`         |                                                                                                                                                                                              | `202 { testId }` (connection check plus the destination's own: folder, table, sheet)                                                                                                                                                                                               |
| `POST /api/admin/destinations/:id/test`          | `{ submissionId? }` (none: a generated sample)                                                                                                                                               | `202 { testId }`                                                                                                                                                                                                                                                                   |
| `POST /api/admin/destinations/:id/backfill`      | `{ submissionIds? } \| { from, to, siteId? }`, `ignoreCondition?` (max 5000)                                                                                                                 | `{ created, skipped, existing }`                                                                                                                                                                                                                                                   |
| `POST /api/admin/destinations/:id/resend-failed` |                                                                                                                                                                                              | `{ resent: number }`                                                                                                                                                                                                                                                               |

Validation on save: `settings` with `destinationSettingsSchemas[kind]`, `include` with
`destinationInclude`, the connection must exist, not be archived and be of kind
`DESTINATION_CONNECTION[kind]` (none for email), formats allowed by `KIND_FORMATS`, each template
must exist, not be archived, be linked to the form and able to produce its format
(`TEMPLATE_FORMATS`). `condition`, mapping expressions and Liquid templates in settings (subject,
file name, folder, message) are checked with `checkExpression` / `checkLiquid` against every
published version of the form (and the draft); warnings are returned, unknown names are errors.
A file name without `_short_id` or `_id` gives a warning. `crossBorder` with personal fields
included needs `confirmCrossBorder: true` (audited). Deactivating or archiving calls
`cancelPendingDeliveries`; `backfillSince` calls `backfillDeliveries`. Every change adds a
`destination_revisions` row and an audit row.

## Templates (admin)

| Route                                                    | Body / query                                                                                                                   | Returns                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/templates`                               | `?formId=`                                                                                                                     | `[{ id, name, kind, formIds, latest: { version, createdAt, warnings } \| null, archivedAt }]`                                                       |
| `POST /api/admin/templates`                              | `{ name, kind: html\|docx, formIds }`                                                                                          | `201 { id }`                                                                                                                                        |
| `GET /api/admin/templates/:id`                           |                                                                                                                                | `{ id, name, kind, formIds, versions: [{ id, version, createdAt, createdBy, placeholders, warnings }], usedBy: [{ destinationId, name, formId }] }` |
| `PATCH /api/admin/templates/:id`                         | `{ name?, formIds?, archived? }`                                                                                               | `{ ok }`                                                                                                                                            |
| `PUT /api/admin/templates/:id/content`                   | raw body: `text/html` (HTML) or `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (Word), at most 5 MB | `201 { version, warnings }`, or `400 { error, details: errors }`                                                                                    |
| `GET /api/admin/templates/:id/versions/:version/content` |                                                                                                                                | the file                                                                                                                                            |
| `POST /api/admin/templates/:id/preview`                  | `{ format, version?, submissionId? }` (none: a sample)                                                                         | the rendered file (audited when a real submission is used)                                                                                          |
| `GET /api/admin/forms/:formId/starter-template`          | `?kind=html\|docx`                                                                                                             | the file                                                                                                                                            |
| `GET /api/admin/forms/:formId/placeholders`              |                                                                                                                                | `[{ name, label, kind: field\|group\|photo\|reserved, sample }]`                                                                                    |
| `PUT /api/admin/forms/:formId/document-templates`        | `{ pdf?: id \| null, docx?: id \| null }`                                                                                      | `{ ok }`                                                                                                                                            |

## Branding (admin)

`PATCH /api/admin/companies/:id` also takes `{ brandColour?, logoBlobId?, documentFooter? }`
(the logo is uploaded first with `PUT /api/blobs/:id`). Settings (`PUT /api/admin/settings`)
gain `deliveryAlertEmails`, `brandName`, `brandColour`.

## Deliveries (admins; managers for submissions they can view)

| Route                                             | Body / query                                                                 | Returns                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/deliveries`                             | `?status&formId&destinationId&from&to&q&limit&cursor`                        | `{ rows: [{ id, submissionId, formName, siteName, destinationId, destinationName, kind, status, generation, attemptCount, nextAttemptAt, lastError (admins), errorClass, errorText, deliveredAt, createdAt, updatedAt }], next }` |
| `GET /api/deliveries/summary`                     |                                                                              | `{ byStatus, destinations: [{ id, name, formName, kind, active, failingSince, consecutiveFailures, lastSuccessAt, last24h }], errors: [{ errorClass, errorText, count }] }`                                                       |
| `GET /api/deliveries/:id`                         |                                                                              | the row plus `attempts: [{ generation, attemptNo, outcome, detail (admins), target, evidence, documents, startedAt, finishedAt, triggeredBy }]`                                                                                   |
| `POST /api/deliveries/:id/resend`                 |                                                                              | `{ generation }` (from delivered, failed, skipped, cancelled)                                                                                                                                                                     |
| `POST /api/deliveries/:id/retry-now`              |                                                                              | `{ ok }` (pending only)                                                                                                                                                                                                           |
| `POST /api/deliveries/resend`                     | `{ ids: string[] }` (max 500)                                                | `{ resent, skipped }`                                                                                                                                                                                                             |
| `GET /api/form-submissions/:id/deliveries`        |                                                                              | `[{ id, destinationName, kind, status, deliveredAt, errorText }]`                                                                                                                                                                 |
| `GET /api/form-submissions/:id/document`          | `?format=pdf\|docx\|xlsx\|json\|xml\|images&templateId=` (`images` is a ZIP) | the file (audited as a view)                                                                                                                                                                                                      |
| `GET /api/system-emails`                          | `?status=failed`                                                             | Phase 1/2 emails that gave up: `[{ id, kind: register\|task, subjectId, title, detail, createdAt }]` (admins)                                                                                                                     |
| `POST /api/system-emails/:kind/:subjectId/resend` |                                                                              | `{ ok }`                                                                                                                                                                                                                          |

## API keys (admin)

| Route                                 | Body                                                                           | Returns                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/api-keys`             |                                                                                | `[{ id, name, prefix, scopes, allSites, siteScopes: [{ type, id, name }], formIds, createdBy, createdAt, expiresAt, lastUsedAt, revokedAt }]` |
| `POST /api/admin/api-keys`            | `{ name, scopes, allSites, siteScopes: [{ type, id }], formIds?, expiresAt? }` | `201 { id, key }` (the key is shown once)                                                                                                     |
| `PATCH /api/admin/api-keys/:id`       | `{ name?, scopes?, allSites?, siteScopes?, formIds?, expiresAt? }`             | `{ ok }`                                                                                                                                      |
| `POST /api/admin/api-keys/:id/revoke` |                                                                                | `{ ok }`                                                                                                                                      |

## Public API (`/api/v1`, `Authorization: Bearer ff_…`)

| Route                                     | Scope              | Returns                                                                                                                |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/forms`                       | `forms:read`       | `[{ id, name, version, versionId, publishedAt }]`                                                                      |
| `GET /api/v1/forms/:id/versions/:version` | `forms:read`       | `{ id, version, definition }`                                                                                          |
| `GET /api/v1/submissions`                 | `submissions:read` | `?formId&since&until&siteId&cursor&limit(≤500)` → `{ data: [submission JSON], next }` ordered by received time then id |
| `GET /api/v1/submissions/:id`             | `submissions:read` | the submission JSON (schema `fieldforms.submission/1`)                                                                 |
| `GET /api/v1/submissions/:id/document`    | `submissions:read` | `?format=` → the file                                                                                                  |
| `GET /api/v1/files/:id`                   | `files:read`       | a photo or signature of a submission the key can see                                                                   |
| `GET /api/v1/attendance/daily`            | `attendance:read`  | `?from&to&siteId` → the daily report rows                                                                              |
| `GET /api/v1/openapi.json`                | none               | the OpenAPI 3.1 document                                                                                               |

Errors: `401 { error }` for a missing, malformed, unknown, revoked or expired key (or one whose
creator is deactivated); `403` for a missing scope or a form/site outside the key; `429` over
the key's rate limit. Keys never see submissions without a site unless `allSites`.

-- Phase 3: document templates, connections, per-form destinations, the delivery log and API keys.
-- See ARCHITECTURE.md, "Phase 3: outputs and destinations".

-- ---------------------------------------------------------------- branding

ALTER TABLE companies
  ADD COLUMN brand_colour    text CHECK (brand_colour ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN logo_blob_id    uuid REFERENCES blobs(id),
  ADD COLUMN document_footer text CHECK (char_length(document_footer) <= 500);

-- ---------------------------------------------------------------- templates

CREATE TABLE output_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind        text NOT NULL CHECK (kind IN ('html', 'docx')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX output_templates_name_uq ON output_templates (lower(name));

-- Saving a template creates a version; versions never change, and each delivery attempt records
-- the ones it used. HTML templates are text; Word templates are the uploaded file.
CREATE TABLE output_template_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES output_templates(id),
  version       integer NOT NULL CHECK (version > 0),
  content_text  text CHECK (char_length(content_text) <= 200000),
  content_bytes bytea CHECK (octet_length(content_bytes) <= 5242880),
  sha256        text NOT NULL,
  -- Placeholders found when it was saved, and the problems reported then (for the editor).
  placeholders  jsonb NOT NULL DEFAULT '[]',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  CHECK ((content_text IS NULL) <> (content_bytes IS NULL))
);

-- The forms a template is written for; it is checked against every version of them.
CREATE TABLE template_forms (
  template_id uuid NOT NULL REFERENCES output_templates(id),
  form_id     uuid NOT NULL REFERENCES forms(id),
  PRIMARY KEY (template_id, form_id)
);

-- The template each format uses for in-app downloads of this form: { "pdf": "<template id>" }.
ALTER TABLE forms ADD COLUMN document_templates jsonb NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------- connections

-- Credentials, stored once and shared by destinations.
CREATE TABLE connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind              text NOT NULL CHECK (kind IN ('webhook', 'sftp', 's3', 'google', 'microsoft',
                                                  'slack', 'sql')),
  -- Non-secret settings (host, tenant, region...).
  config            jsonb NOT NULL DEFAULT '{}',
  -- Sealed to the worker's key (lib/secrets.ts, "v2:<key id>:..."), bound to this row's id. The
  -- API can seal but never open it.
  secrets           text,
  -- Which secret fields are set (names only), for the admin screen.
  secret_keys       text[] NOT NULL DEFAULT '{}',
  -- Bumped whenever the secrets change, so a revision says which secrets it used.
  secrets_version   integer NOT NULL DEFAULT 0,
  secret_expires_on date,
  revision          integer NOT NULL DEFAULT 1,
  last_check_at     timestamptz,
  last_check_ok     boolean,
  last_check_detail text CHECK (char_length(last_check_detail) <= 1000),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz
);
CREATE UNIQUE INDEX connections_name_uq ON connections (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE connection_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   uuid NOT NULL REFERENCES connections(id),
  revision        integer NOT NULL CHECK (revision > 0),
  name            text NOT NULL,
  config          jsonb NOT NULL,
  secrets_version integer NOT NULL,
  -- Set when this change cleared the secrets because the connection now points elsewhere.
  secrets_reset   boolean NOT NULL DEFAULT false,
  archived        boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, revision)
);

-- ---------------------------------------------------------------- destinations

CREATE TABLE destinations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id              uuid NOT NULL REFERENCES forms(id),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind                 text NOT NULL CHECK (kind IN ('email', 'webhook', 'sftp', 's3', 'google_drive',
                                                     'onedrive', 'slack', 'sql', 'google_sheets')),
  -- NULL only for email, which uses the server's SMTP settings.
  connection_id        uuid REFERENCES connections(id),
  -- Documents it carries, and the template for each: { "pdf": "<template id>" }.
  formats              text[] NOT NULL DEFAULT '{}'
                       CHECK (formats <@ ARRAY['pdf', 'docx', 'xlsx', 'json', 'xml', 'images']),
  templates            jsonb NOT NULL DEFAULT '{}',
  -- An expression in the form language; the destination is used only when it is TRUE.
  condition            text CHECK (char_length(condition) <= 2000),
  -- Per-form settings of its kind (recipients, folder, file name, table, mappings...).
  settings             jsonb NOT NULL DEFAULT '{}',
  -- POPIA: what it may carry ({ fields, photos, signatures, location, submitter }).
  include              jsonb NOT NULL DEFAULT '{}',
  -- Who receives the data (the operator), and whether it leaves South Africa.
  recipient            text CHECK (char_length(recipient) <= 200),
  cross_border         boolean NOT NULL DEFAULT false,
  active               boolean NOT NULL DEFAULT true,
  revision             integer NOT NULL DEFAULT 1,
  -- Incident tracking: one alert per run of failures, a daily reminder, a note on recovery.
  failing_since        timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  incident_alerted_at  timestamptz,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  archived_at          timestamptz,
  CHECK ((kind = 'email') = (connection_id IS NULL))
);
CREATE INDEX destinations_form_idx ON destinations (form_id) WHERE archived_at IS NULL;
CREATE INDEX destinations_connection_idx ON destinations (connection_id);

-- What a destination looked like at each change, so the delivery log shows exactly where and
-- how a submission was sent.
CREATE TABLE destination_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES destinations(id),
  revision       integer NOT NULL CHECK (revision > 0),
  name           text NOT NULL,
  connection_id  uuid REFERENCES connections(id),
  formats        text[] NOT NULL,
  templates      jsonb NOT NULL,
  condition      text,
  settings       jsonb NOT NULL,
  include        jsonb NOT NULL,
  recipient      text,
  cross_border   boolean NOT NULL,
  active         boolean NOT NULL,
  archived       boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination_id, revision)
);

-- ---------------------------------------------------------------- rendered documents

-- A document rendered once for a submission, format, template version and include settings,
-- stored in the blob store and reused by every destination, retry and download.
CREATE TABLE rendered_documents (
  cache_key           text PRIMARY KEY,
  submission_id       uuid NOT NULL REFERENCES form_submissions(id),
  format              text NOT NULL,
  template_version_id uuid REFERENCES output_template_versions(id),
  -- [{ "filename", "contentType", "size", "sha256", "storageKey" }]
  files               jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rendered_documents_submission_idx ON rendered_documents (submission_id);

-- ---------------------------------------------------------------- deliveries

-- One row per submission once its deliveries have been worked out (append-only marker).
CREATE TABLE delivery_plans (
  submission_id uuid PRIMARY KEY REFERENCES form_submissions(id),
  planned_at    timestamptz NOT NULL DEFAULT now()
);

-- The state machine for one submission going to one destination. The row is the lock: a worker
-- claims it with a lease token, and only the holder of the token can finish the attempt. The job
-- queue only wakes workers up; retries and back-off are decided here (next_attempt_at).
CREATE TABLE deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id        uuid NOT NULL REFERENCES form_submissions(id),
  destination_id       uuid NOT NULL REFERENCES destinations(id),
  status               text NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed',
                                                        'skipped', 'cancelled')),
  -- A resend starts a new generation; jobs and idempotency keys carry it.
  generation           integer NOT NULL DEFAULT 1,
  -- Attempts in the current generation.
  attempt_count        integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  lease_token          uuid,
  lease_until          timestamptz,
  -- Fixed for a generation so every retry sends the same thing to the same place.
  template_version_ids jsonb,
  target               jsonb,
  last_error           text CHECK (char_length(last_error) <= 300),
  -- Plain-language class of the last error, for managers.
  last_error_class     text,
  delivered_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, destination_id),
  CHECK ((status = 'sending') = (lease_token IS NOT NULL))
);
CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX deliveries_sending_idx ON deliveries (lease_until) WHERE status = 'sending';
CREATE INDEX deliveries_failed_idx ON deliveries (destination_id) WHERE status = 'failed';
CREATE INDEX deliveries_destination_idx ON deliveries (destination_id, created_at DESC);
CREATE INDEX deliveries_submission_idx ON deliveries (submission_id);

-- One row per try, written when the try ends (or by the sweeper when a worker vanished).
CREATE TABLE delivery_attempts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id             uuid NOT NULL REFERENCES deliveries(id),
  generation              integer NOT NULL,
  attempt_no              integer NOT NULL CHECK (attempt_no >= 0),
  outcome                 text NOT NULL CHECK (outcome IN ('delivered', 'already_present', 'retry',
                                                           'failed', 'skipped', 'cancelled', 'abandoned')),
  detail                  text CHECK (char_length(detail) <= 300),
  destination_revision_id uuid REFERENCES destination_revisions(id),
  connection_revision_id  uuid REFERENCES connection_revisions(id),
  template_version_ids    jsonb,
  -- [{ filename, contentType, size, sha256 }]
  documents               jsonb,
  -- Where it went, without secrets: recipients, URL origin and path, bucket and key, remote path.
  target                  jsonb,
  -- What the destination said: SMTP message id, HTTP status, ETag, file id. Never bodies.
  evidence                jsonb,
  job_id                  text,
  worker                  text,
  started_at              timestamptz NOT NULL,
  finished_at             timestamptz NOT NULL DEFAULT now(),
  -- Set for a manual resend, retry or backfill.
  triggered_by            uuid REFERENCES users(id)
);
CREATE INDEX delivery_attempts_delivery_idx ON delivery_attempts (delivery_id, generation, attempt_no);

-- A connection check or test send, run by the worker (only it can open secrets). The admin
-- screen polls the row for the result.
CREATE TABLE destination_tests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('check', 'test_send')),
  connection_id  uuid REFERENCES connections(id),
  destination_id uuid REFERENCES destinations(id),
  -- Unsaved connection settings to check, with any secrets typed in sealed to this row.
  draft_kind     text,
  draft_config   jsonb,
  draft_secrets  text,
  -- A test send uses a generated sample unless an admin picked a real submission.
  submission_id  uuid REFERENCES form_submissions(id),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed')),
  -- Safe text and evidence only: never secrets, response bodies or raw socket errors.
  result         jsonb,
  requested_by   uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  CHECK (connection_id IS NOT NULL OR destination_id IS NOT NULL OR draft_config IS NOT NULL)
);

-- Alerts sent (incident, reminder, recovery, system emails that gave up, secret expiry).
CREATE TABLE delivery_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('incident', 'reminder', 'recovered', 'system_email',
                                               'secret_expiry')),
  destination_id uuid REFERENCES destinations(id),
  connection_id  uuid REFERENCES connections(id),
  recipients     text[] NOT NULL,
  -- What the alert covered (delivery ids, notification ids, counts).
  items          jsonb NOT NULL DEFAULT '{}',
  sent_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_alerts_destination_idx ON delivery_alerts (destination_id, sent_at DESC);

-- ---------------------------------------------------------------- API keys

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Za-z0-9]{8}$'),
  -- SHA-256 of the whole key; the key itself is shown once and never stored.
  key_hash     bytea NOT NULL,
  scopes       text[] NOT NULL,
  -- Without all_sites a key sees only its listed companies, regions and sites, and never
  -- submissions that have no site.
  all_sites    boolean NOT NULL DEFAULT false,
  -- Optional: only these forms. NULL means every form.
  form_ids     uuid[],
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id)
);

CREATE TABLE api_key_scopes (
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  scope_type text NOT NULL CHECK (scope_type IN ('company', 'region', 'site')),
  scope_id   uuid NOT NULL,
  PRIMARY KEY (api_key_id, scope_type, scope_id)
);

-- Audit rows written for API calls name the key instead of a user; never both.
ALTER TABLE audit_log ADD COLUMN actor_api_key_id uuid REFERENCES api_keys(id);
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_one_actor CHECK (actor_user_id IS NULL OR actor_api_key_id IS NULL);

-- ---------------------------------------------------------------- immutability and grants

CREATE TRIGGER output_template_versions_append_only BEFORE UPDATE OR DELETE ON output_template_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER connection_revisions_append_only BEFORE UPDATE OR DELETE ON connection_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER destination_revisions_append_only BEFORE UPDATE OR DELETE ON destination_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER rendered_documents_append_only BEFORE UPDATE OR DELETE ON rendered_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER delivery_plans_append_only BEFORE UPDATE OR DELETE ON delivery_plans
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER delivery_attempts_append_only BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER delivery_alerts_append_only BEFORE UPDATE OR DELETE ON delivery_alerts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

REVOKE UPDATE ON output_template_versions, connection_revisions, destination_revisions,
  rendered_documents, delivery_plans, delivery_attempts, delivery_alerts FROM fieldforms_app;
-- Unlinking a template from a form and replacing an API key's site scope are the only deletes.
GRANT DELETE ON template_forms, api_key_scopes TO fieldforms_app;

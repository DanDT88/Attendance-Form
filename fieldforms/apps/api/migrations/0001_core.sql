-- FieldForms core schema: organisation, people, access, attendance, audit.
-- Runs as the database owner. The API connects as fieldforms_app (see 0002).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- organisation

CREATE TABLE companies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  report_recipients text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz
);
CREATE UNIQUE INDEX companies_name_uq ON companies (lower(name));

CREATE TABLE regions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
CREATE UNIQUE INDEX regions_name_uq ON regions (company_id, lower(name));

CREATE TABLE sites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id         uuid NOT NULL REFERENCES regions(id),
  name              text NOT NULL,
  lat               double precision CHECK (lat BETWEEN -90 AND 90),
  lng               double precision CHECK (lng BETWEEN -180 AND 180),
  geofence_metres   integer NOT NULL DEFAULT 1000 CHECK (geofence_metres > 0),
  -- NULL means "use the company's recipients".
  report_recipients text[],
  created_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz,
  CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE UNIQUE INDEX sites_name_uq ON sites (region_id, lower(name));

CREATE TABLE shifts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES sites(id),
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('day', 'night')),
  start_time     time NOT NULL,
  end_time       time NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
CREATE INDEX shifts_site_idx ON shifts (site_id);

-- ---------------------------------------------------------------- people

CREATE TABLE employees (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no         text NOT NULL UNIQUE,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  title               text,
  site_id             uuid REFERENCES sites(id),
  -- Set when the employee is in the replacement pool for this region.
  pool_region_id      uuid REFERENCES regions(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  anonymised_at       timestamptz
);
CREATE INDEX employees_site_idx ON employees (site_id) WHERE status = 'active';
CREATE INDEX employees_pool_idx ON employees (pool_region_id) WHERE status = 'active';

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role             text NOT NULL CHECK (role IN ('admin', 'manager', 'supervisor')),
  display_name     text NOT NULL,
  email            citext UNIQUE,
  employee_no      text UNIQUE,
  pin_hash         text,
  password_hash    text,
  oidc_issuer      text,
  oidc_subject     text,
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  UNIQUE (oidc_issuer, oidc_subject),
  -- Supervisors sign in with an employee number and PIN; office users with an email.
  CHECK (role <> 'supervisor' OR employee_no IS NOT NULL),
  CHECK (role = 'supervisor' OR email IS NOT NULL)
);

CREATE TABLE user_scopes (
  user_id    uuid NOT NULL REFERENCES users(id),
  scope_type text NOT NULL CHECK (scope_type IN ('company', 'region', 'site')),
  scope_id   uuid NOT NULL,
  PRIMARY KEY (user_id, scope_type, scope_id)
);

CREATE TABLE sessions (
  -- SHA-256 of the cookie token; the token itself is never stored.
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  notice_version text NOT NULL,
  accepted_at    timestamptz NOT NULL DEFAULT now(),
  ip             text,
  UNIQUE (user_id, notice_version)
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------- attendance

CREATE TABLE blobs (
  id           uuid PRIMARY KEY,
  sha256       text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  storage_key  text NOT NULL,
  uploaded_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE register_submissions (
  -- Generated on the device: the idempotency key for offline retries.
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('start', 'late', 'left_early', 'end', 'manual')),
  site_id             uuid NOT NULL REFERENCES sites(id),
  shift_id            uuid REFERENCES shifts(id),
  work_date           date NOT NULL,
  submitted_by        uuid REFERENCES users(id),
  sign_off_name       text,
  reason              text,
  device_captured_at  timestamptz,
  device_sent_at      timestamptz,
  server_received_at  timestamptz NOT NULL DEFAULT now(),
  clock_skew_seconds  integer,
  clock_skew_flag     boolean NOT NULL DEFAULT false,
  sync_delay_seconds  integer,
  sync_delay_flag     boolean NOT NULL DEFAULT false,
  lat                 double precision,
  lng                 double precision,
  accuracy_metres     double precision,
  distance_metres     integer,
  -- NULL = could not be determined. Never read NULL as compliant.
  geo_ok              boolean,
  time_ok             boolean,
  supervisor_photo_id uuid REFERENCES blobs(id),
  staff_photo_id      uuid REFERENCES blobs(id),
  source              text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'legacy', 'seed')),
  legacy_ref          text,
  payload             jsonb,
  CHECK (kind <> 'manual' OR length(trim(coalesce(reason, ''))) >= 3)
);
CREATE INDEX register_submissions_site_date_idx ON register_submissions (site_id, work_date);
CREATE INDEX register_submissions_date_idx ON register_submissions (work_date);
CREATE UNIQUE INDEX register_submissions_legacy_uq ON register_submissions (legacy_ref) WHERE legacy_ref IS NOT NULL;

CREATE TABLE attendance_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id           uuid NOT NULL REFERENCES register_submissions(id),
  employee_id             uuid NOT NULL REFERENCES employees(id),
  status                  text NOT NULL CHECK (status IN ('present', 'late', 'absent', 'left_early')),
  event                   text CHECK (event IN ('in', 'out')),
  event_at                timestamptz,
  minutes                 integer,
  reason                  text,
  replacement_employee_id uuid REFERENCES employees(id),
  UNIQUE (submission_id, employee_id),
  CHECK ((event IS NULL) = (event_at IS NULL))
);
CREATE INDEX attendance_entries_employee_idx ON attendance_entries (employee_id);

CREATE TABLE entry_corrections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES attendance_entries(id),
  -- Full snapshots of the correctable fields, so the effective value never depends on replaying.
  old_values   jsonb NOT NULL,
  new_values   jsonb NOT NULL,
  reason       text NOT NULL CHECK (length(trim(reason)) >= 3),
  corrected_by uuid NOT NULL REFERENCES users(id),
  corrected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX entry_corrections_entry_idx ON entry_corrections (entry_id, corrected_at DESC);

-- The latest correction wins; with none, the original stands.
CREATE VIEW attendance_entries_effective AS
SELECT
  e.id,
  e.submission_id,
  e.employee_id,
  CASE WHEN c.new_values IS NULL THEN e.status ELSE c.new_values->>'status' END AS status,
  CASE WHEN c.new_values IS NULL THEN e.event ELSE c.new_values->>'event' END AS event,
  CASE WHEN c.new_values IS NULL THEN e.event_at ELSE (c.new_values->>'eventAt')::timestamptz END AS event_at,
  CASE WHEN c.new_values IS NULL THEN e.minutes ELSE (c.new_values->>'minutes')::integer END AS minutes,
  CASE WHEN c.new_values IS NULL THEN e.reason ELSE c.new_values->>'reason' END AS reason,
  CASE WHEN c.new_values IS NULL THEN e.replacement_employee_id
       ELSE (c.new_values->>'replacementEmployeeId')::uuid END AS replacement_employee_id,
  (c.new_values IS NOT NULL) AS corrected,
  coalesce(c.correction_count, 0)::integer AS correction_count
FROM attendance_entries e
LEFT JOIN LATERAL (
  SELECT ec.new_values, count(*) OVER () AS correction_count
  FROM entry_corrections ec
  WHERE ec.entry_id = e.id
  ORDER BY ec.corrected_at DESC, ec.id DESC
  LIMIT 1
) c ON true;

CREATE TABLE notification_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES register_submissions(id),
  channel       text NOT NULL DEFAULT 'email',
  status        text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipients    text[] NOT NULL DEFAULT '{}',
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_log_sent_uq ON notification_log (submission_id, channel) WHERE status = 'sent';

-- ---------------------------------------------------------------- privacy and audit

CREATE TABLE privacy_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  kind            text NOT NULL CHECK (kind IN ('access', 'deletion')),
  status          text NOT NULL CHECK (status IN ('completed', 'refused')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id uuid REFERENCES users(id),
  action        text NOT NULL,
  entity        text,
  entity_id     text,
  ip            text,
  user_agent    text,
  details       jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

-- ---------------------------------------------------------------- append-only enforcement

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER register_submissions_append_only BEFORE UPDATE OR DELETE ON register_submissions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER attendance_entries_append_only BEFORE UPDATE OR DELETE ON attendance_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entry_corrections_append_only BEFORE UPDATE OR DELETE ON entry_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER notification_log_append_only BEFORE UPDATE OR DELETE ON notification_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER privacy_requests_append_only BEFORE UPDATE OR DELETE ON privacy_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- TRUNCATE bypasses row triggers, so block it separately.
CREATE TRIGGER register_submissions_no_truncate BEFORE TRUNCATE ON register_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER attendance_entries_no_truncate BEFORE TRUNCATE ON attendance_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entry_corrections_no_truncate BEFORE TRUNCATE ON entry_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

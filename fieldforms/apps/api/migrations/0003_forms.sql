-- Phase 2: versioned forms, managed option lists, user groups, form submissions and dispatch.

-- ---------------------------------------------------------------- definitions

CREATE TABLE forms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  -- The editable draft. Publishing copies it into form_versions; it is never itself filled in.
  draft_definition jsonb NOT NULL,
  draft_updated_at timestamptz NOT NULL DEFAULT now(),
  draft_updated_by uuid REFERENCES users(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);
CREATE UNIQUE INDEX forms_name_uq ON forms (lower(name));

CREATE TABLE form_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      uuid NOT NULL REFERENCES forms(id),
  version      integer NOT NULL CHECK (version > 0),
  definition   jsonb NOT NULL,
  published_by uuid REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, version)
);

CREATE TABLE option_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- [{ "value": "...", "label": "..." }]. Submissions store the chosen value, so editing a list
  -- never changes what an old submission says.
  items       jsonb NOT NULL DEFAULT '[]',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX option_lists_name_uq ON option_lists (lower(name));

-- ---------------------------------------------------------------- groups and dispatch

CREATE TABLE user_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX user_groups_name_uq ON user_groups (lower(name));

CREATE TABLE user_group_members (
  group_id uuid NOT NULL REFERENCES user_groups(id),
  user_id  uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX user_group_members_user_idx ON user_group_members (user_id);

CREATE TABLE dispatches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id                 uuid NOT NULL REFERENCES forms(id),
  -- Fixed when dispatched, so the assignee fills in the version the dispatcher saw.
  form_version_id         uuid NOT NULL REFERENCES form_versions(id),
  title                   text NOT NULL,
  instructions            text,
  prefill                 jsonb NOT NULL DEFAULT '{}',
  site_id                 uuid REFERENCES sites(id),
  assigned_user_id        uuid REFERENCES users(id),
  assigned_group_id       uuid REFERENCES user_groups(id),
  due_on                  date,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  completed_by            uuid REFERENCES users(id),
  completed_submission_id uuid,
  cancelled_at            timestamptz,
  cancelled_by            uuid REFERENCES users(id),
  CHECK ((assigned_user_id IS NULL) <> (assigned_group_id IS NULL))
);
CREATE INDEX dispatches_user_open_idx ON dispatches (assigned_user_id) WHERE status = 'open';
CREATE INDEX dispatches_group_open_idx ON dispatches (assigned_group_id) WHERE status = 'open';

-- ---------------------------------------------------------------- submissions

CREATE TABLE form_submissions (
  -- Generated on the device: the idempotency key for offline retries.
  id                 uuid PRIMARY KEY,
  form_id            uuid NOT NULL REFERENCES forms(id),
  form_version_id    uuid NOT NULL REFERENCES form_versions(id),
  dispatch_id        uuid REFERENCES dispatches(id),
  site_id            uuid REFERENCES sites(id),
  submitted_by       uuid REFERENCES users(id),
  -- The answers as the server evaluated them: visible fields only, calculations recomputed.
  data               jsonb NOT NULL,
  device_captured_at timestamptz,
  device_sent_at     timestamptz,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  clock_skew_seconds integer,
  clock_skew_flag    boolean NOT NULL DEFAULT false,
  sync_delay_seconds integer,
  sync_delay_flag    boolean NOT NULL DEFAULT false,
  -- What the device sent, kept as evidence.
  payload            jsonb
);
CREATE INDEX form_submissions_form_idx ON form_submissions (form_id, server_received_at DESC);
CREATE INDEX form_submissions_site_idx ON form_submissions (site_id, server_received_at DESC);
CREATE INDEX form_submissions_user_idx ON form_submissions (submitted_by, server_received_at DESC);

ALTER TABLE dispatches
  ADD CONSTRAINT dispatches_completed_submission_fk
  FOREIGN KEY (completed_submission_id) REFERENCES form_submissions(id);

CREATE TABLE form_submission_files (
  submission_id uuid NOT NULL REFERENCES form_submissions(id),
  blob_id       uuid NOT NULL REFERENCES blobs(id),
  path          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('image', 'annotation', 'signature')),
  PRIMARY KEY (submission_id, blob_id)
);
CREATE INDEX form_submission_files_blob_idx ON form_submission_files (blob_id);

-- ---------------------------------------------------------------- notifications for dispatches

ALTER TABLE notification_log ALTER COLUMN submission_id DROP NOT NULL;
ALTER TABLE notification_log ADD COLUMN dispatch_id uuid REFERENCES dispatches(id);
ALTER TABLE notification_log
  ADD CONSTRAINT notification_log_one_subject CHECK ((submission_id IS NULL) <> (dispatch_id IS NULL));
CREATE UNIQUE INDEX notification_log_dispatch_sent_uq ON notification_log (dispatch_id, channel)
  WHERE status = 'sent' AND dispatch_id IS NOT NULL;

-- ---------------------------------------------------------------- immutability and grants

CREATE TRIGGER form_versions_append_only BEFORE UPDATE OR DELETE ON form_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER form_submissions_append_only BEFORE UPDATE OR DELETE ON form_submissions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER form_submission_files_append_only BEFORE UPDATE OR DELETE ON form_submission_files
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER form_versions_no_truncate BEFORE TRUNCATE ON form_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER form_submissions_no_truncate BEFORE TRUNCATE ON form_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- New tables already get SELECT, INSERT, UPDATE through the default privileges set in 0002.
REVOKE UPDATE ON form_versions, form_submissions, form_submission_files FROM fieldforms_app;
-- Changing a group's members is the only delete these tables need.
GRANT DELETE ON user_group_members TO fieldforms_app;

-- The API and worker connect as fieldforms_app. It does not own any table, so it cannot drop or
-- disable the append-only triggers, and it has no DELETE or TRUNCATE except where noted.
-- Its password is set by the migration runner from APP_DB_PASSWORD, never stored here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fieldforms_app') THEN
    CREATE ROLE fieldforms_app LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  -- pg-boss creates and owns its own schema, so the app role needs CREATE on the database.
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO fieldforms_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO fieldforms_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fieldforms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fieldforms_app;

-- Signing out and replacing scopes are the only deletes the app performs.
GRANT DELETE ON sessions, user_scopes TO fieldforms_app;

-- Belt and braces on top of the triggers: no UPDATE on the immutable tables either.
REVOKE UPDATE ON register_submissions, attendance_entries, entry_corrections, audit_log,
  notification_log, privacy_requests FROM fieldforms_app;

-- Tables added by later migrations get the same default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO fieldforms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO fieldforms_app;

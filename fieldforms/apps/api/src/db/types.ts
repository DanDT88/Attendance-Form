import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

/** A timestamptz: read as Date, written as Date or ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
/** `date` columns are parsed as 'YYYY-MM-DD' strings (see db/index.ts), never as local-midnight Dates. */
type DateString = string;
type Json = ColumnType<unknown, string, string>;

export interface CompaniesTable {
  id: Generated<string>;
  name: string;
  report_recipients: ColumnType<string[], string[] | undefined, string[]>;
  brand_colour: ColumnType<string | null, string | null | undefined, string | null>;
  logo_blob_id: ColumnType<string | null, string | null | undefined, string | null>;
  document_footer: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TimestampDefault;
  deactivated_at: Timestamp | null;
}

export interface RegionsTable {
  id: Generated<string>;
  company_id: string;
  name: string;
  created_at: TimestampDefault;
  deactivated_at: Timestamp | null;
}

export interface SitesTable {
  id: Generated<string>;
  region_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  geofence_metres: ColumnType<number, number | undefined, number>;
  report_recipients: string[] | null;
  created_at: TimestampDefault;
  deactivated_at: Timestamp | null;
}

export interface ShiftsTable {
  id: Generated<string>;
  site_id: string;
  name: string;
  kind: 'day' | 'night';
  start_time: string;
  end_time: string;
  created_at: TimestampDefault;
  deactivated_at: Timestamp | null;
}

export interface EmployeesTable {
  id: Generated<string>;
  employee_no: string;
  first_name: string;
  last_name: string;
  title: string | null;
  site_id: string | null;
  pool_region_id: string | null;
  status: ColumnType<
    'active' | 'inactive',
    'active' | 'inactive' | undefined,
    'active' | 'inactive'
  >;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
  anonymised_at: Timestamp | null;
}

export interface UsersTable {
  id: Generated<string>;
  role: 'admin' | 'manager' | 'supervisor';
  display_name: string;
  email: string | null;
  employee_no: string | null;
  pin_hash: string | null;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  failed_attempts: ColumnType<number, number | undefined, number>;
  locked_until: Timestamp | null;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: TimestampDefault;
  last_login_at: Timestamp | null;
}

export interface UserScopesTable {
  user_id: string;
  scope_type: 'company' | 'region' | 'site';
  scope_id: string;
}

export interface SessionsTable {
  token_hash: string;
  user_id: string;
  created_at: TimestampDefault;
  expires_at: Timestamp;
  last_seen_at: TimestampDefault;
  ip: string | null;
  user_agent: string | null;
}

export interface ConsentsTable {
  id: Generated<string>;
  user_id: string;
  notice_version: string;
  accepted_at: TimestampDefault;
  ip: string | null;
}

export interface SettingsTable {
  key: string;
  value: Json;
  updated_at: TimestampDefault;
  updated_by: string | null;
}

export interface BlobsTable {
  id: string;
  sha256: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  uploaded_by: string | null;
  created_at: TimestampDefault;
}

export interface RegisterSubmissionsTable {
  id: string;
  kind: 'start' | 'late' | 'left_early' | 'end' | 'manual';
  site_id: string;
  shift_id: string | null;
  work_date: DateString;
  submitted_by: string | null;
  sign_off_name: string | null;
  reason: string | null;
  device_captured_at: Timestamp | null;
  device_sent_at: Timestamp | null;
  server_received_at: TimestampDefault;
  clock_skew_seconds: number | null;
  clock_skew_flag: ColumnType<boolean, boolean | undefined, never>;
  sync_delay_seconds: number | null;
  sync_delay_flag: ColumnType<boolean, boolean | undefined, never>;
  lat: number | null;
  lng: number | null;
  accuracy_metres: number | null;
  distance_metres: number | null;
  geo_ok: boolean | null;
  time_ok: boolean | null;
  supervisor_photo_id: string | null;
  staff_photo_id: string | null;
  source: ColumnType<'app' | 'legacy' | 'seed', 'app' | 'legacy' | 'seed' | undefined, never>;
  legacy_ref: string | null;
  payload: Json | null;
}

export interface AttendanceEntriesTable {
  id: Generated<string>;
  submission_id: string;
  employee_id: string;
  status: 'present' | 'late' | 'absent' | 'left_early';
  event: 'in' | 'out' | null;
  event_at: Timestamp | null;
  minutes: number | null;
  reason: string | null;
  replacement_employee_id: string | null;
}

export interface AttendanceEntriesEffectiveView {
  id: string;
  submission_id: string;
  employee_id: string;
  status: 'present' | 'late' | 'absent' | 'left_early';
  event: 'in' | 'out' | null;
  event_at: Date | null;
  minutes: number | null;
  reason: string | null;
  replacement_employee_id: string | null;
  corrected: boolean;
  correction_count: number;
}

export interface EntryCorrectionsTable {
  id: Generated<string>;
  entry_id: string;
  old_values: Json;
  new_values: Json;
  reason: string;
  corrected_by: string;
  corrected_at: TimestampDefault;
}

export interface NotificationLogTable {
  id: Generated<string>;
  submission_id: string | null;
  dispatch_id: ColumnType<string | null, string | null | undefined, never>;
  channel: ColumnType<string, string | undefined, never>;
  status: 'sent' | 'failed' | 'skipped';
  recipients: ColumnType<string[], string[] | undefined, never>;
  detail: string | null;
  created_at: TimestampDefault;
}

export interface PrivacyRequestsTable {
  id: Generated<string>;
  employee_id: string;
  kind: 'access' | 'deletion';
  status: 'completed' | 'refused';
  requested_by: string;
  decision_reason: string | null;
  created_at: TimestampDefault;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: TimestampDefault;
  actor_user_id: string | null;
  actor_api_key_id: ColumnType<string | null, string | null | undefined, string | null>;
  action: string;
  entity: string | null;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: Json | null;
}

export interface FormsTable {
  id: Generated<string>;
  name: string;
  document_templates: ColumnType<unknown, string | undefined, string>;
  draft_definition: Json;
  draft_updated_at: TimestampDefault;
  draft_updated_by: string | null;
  created_by: string | null;
  created_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface FormVersionsTable {
  id: Generated<string>;
  form_id: string;
  version: number;
  definition: Json;
  published_by: string | null;
  published_at: TimestampDefault;
}

export interface OptionListsTable {
  id: Generated<string>;
  name: string;
  items: ColumnType<unknown, string | undefined, string>;
  updated_at: TimestampDefault;
  updated_by: string | null;
  created_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface UserGroupsTable {
  id: Generated<string>;
  name: string;
  created_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface UserGroupMembersTable {
  group_id: string;
  user_id: string;
}

export interface DispatchesTable {
  id: Generated<string>;
  form_id: string;
  form_version_id: string;
  title: string;
  instructions: string | null;
  prefill: ColumnType<unknown, string | undefined, string>;
  site_id: string | null;
  assigned_user_id: string | null;
  assigned_group_id: string | null;
  due_on: string | null;
  status: ColumnType<
    'open' | 'completed' | 'cancelled',
    'open' | undefined,
    'completed' | 'cancelled'
  >;
  created_by: string;
  created_at: TimestampDefault;
  completed_at: Timestamp | null;
  completed_by: string | null;
  completed_submission_id: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
}

export interface FormSubmissionsTable {
  id: string;
  form_id: string;
  form_version_id: string;
  dispatch_id: string | null;
  site_id: string | null;
  submitted_by: string | null;
  data: Json;
  device_captured_at: Timestamp | null;
  device_sent_at: Timestamp | null;
  server_received_at: TimestampDefault;
  clock_skew_seconds: number | null;
  clock_skew_flag: ColumnType<boolean, boolean | undefined, never>;
  sync_delay_seconds: number | null;
  sync_delay_flag: ColumnType<boolean, boolean | undefined, never>;
  payload: Json | null;
}

export interface FormSubmissionFilesTable {
  submission_id: string;
  blob_id: string;
  path: string;
  kind: 'image' | 'annotation' | 'signature';
}

// ---------------------------------------------------------------- Phase 3

/** A jsonb column that may be NULL. */
type JsonNullable = ColumnType<unknown, string | null | undefined, string | null>;
type JsonDefault = ColumnType<unknown, string | undefined, string>;
type Bytes = ColumnType<Buffer, Buffer, Buffer>;
type Default<T> = ColumnType<T, T | undefined, T>;

export interface OutputTemplatesTable {
  id: Generated<string>;
  name: string;
  kind: 'html' | 'docx';
  created_by: string | null;
  created_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface OutputTemplateVersionsTable {
  id: Generated<string>;
  template_id: string;
  version: number;
  content_text: string | null;
  content_bytes: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  sha256: string;
  placeholders: JsonDefault;
  created_by: string | null;
  created_at: TimestampDefault;
}

export interface TemplateFormsTable {
  template_id: string;
  form_id: string;
}

export type ConnectionKindColumn =
  'webhook' | 'sftp' | 's3' | 'google' | 'microsoft' | 'slack' | 'sql';

export interface ConnectionsTable {
  id: Generated<string>;
  name: string;
  kind: ConnectionKindColumn;
  config: JsonDefault;
  secrets: string | null;
  secret_keys: Default<string[]>;
  secrets_version: Default<number>;
  secret_expires_on: DateString | null;
  revision: Default<number>;
  last_check_at: Timestamp | null;
  last_check_ok: boolean | null;
  last_check_detail: string | null;
  created_by: string | null;
  created_at: TimestampDefault;
  updated_by: string | null;
  updated_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface ConnectionRevisionsTable {
  id: Generated<string>;
  connection_id: string;
  revision: number;
  name: string;
  config: Json;
  secrets_version: number;
  secrets_reset: ColumnType<boolean, boolean | undefined, never>;
  archived: ColumnType<boolean, boolean | undefined, never>;
  created_by: string | null;
  created_at: TimestampDefault;
}

export type DestinationKindColumn =
  | 'email'
  | 'webhook'
  | 'sftp'
  | 's3'
  | 'google_drive'
  | 'onedrive'
  | 'slack'
  | 'sql'
  | 'google_sheets';
export type FormatColumn = 'pdf' | 'docx' | 'xlsx' | 'json' | 'xml' | 'images';

export interface DestinationsTable {
  id: Generated<string>;
  form_id: string;
  name: string;
  kind: DestinationKindColumn;
  connection_id: string | null;
  formats: Default<FormatColumn[]>;
  templates: JsonDefault;
  condition: string | null;
  settings: JsonDefault;
  include: JsonDefault;
  recipient: string | null;
  cross_border: Default<boolean>;
  active: Default<boolean>;
  revision: Default<number>;
  failing_since: Timestamp | null;
  consecutive_failures: Default<number>;
  last_success_at: Timestamp | null;
  last_failure_at: Timestamp | null;
  incident_alerted_at: Timestamp | null;
  created_by: string | null;
  created_at: TimestampDefault;
  updated_by: string | null;
  updated_at: TimestampDefault;
  archived_at: Timestamp | null;
}

export interface DestinationRevisionsTable {
  id: Generated<string>;
  destination_id: string;
  revision: number;
  name: string;
  connection_id: string | null;
  formats: FormatColumn[];
  templates: Json;
  condition: string | null;
  settings: Json;
  include: Json;
  recipient: string | null;
  cross_border: boolean;
  active: boolean;
  archived: ColumnType<boolean, boolean | undefined, never>;
  created_by: string | null;
  created_at: TimestampDefault;
}

export interface RenderedDocumentsTable {
  cache_key: string;
  submission_id: string;
  format: FormatColumn;
  template_version_id: string | null;
  files: Json;
  created_at: TimestampDefault;
}

export interface DeliveryPlansTable {
  submission_id: string;
  planned_at: TimestampDefault;
}

export type DeliveryStatusColumn =
  'pending' | 'sending' | 'delivered' | 'failed' | 'skipped' | 'cancelled';

export interface DeliveriesTable {
  id: Generated<string>;
  submission_id: string;
  destination_id: string;
  status: DeliveryStatusColumn;
  generation: Default<number>;
  attempt_count: Default<number>;
  next_attempt_at: TimestampDefault;
  lease_token: string | null;
  lease_until: Timestamp | null;
  template_version_ids: JsonNullable;
  target: JsonNullable;
  last_error: string | null;
  last_error_class: string | null;
  delivered_at: Timestamp | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export type AttemptOutcomeColumn =
  'delivered' | 'already_present' | 'retry' | 'failed' | 'skipped' | 'cancelled' | 'abandoned';

export interface DeliveryAttemptsTable {
  id: Generated<string>;
  delivery_id: string;
  generation: number;
  attempt_no: number;
  outcome: AttemptOutcomeColumn;
  detail: string | null;
  destination_revision_id: string | null;
  connection_revision_id: string | null;
  template_version_ids: JsonNullable;
  documents: JsonNullable;
  target: JsonNullable;
  evidence: JsonNullable;
  job_id: string | null;
  worker: string | null;
  started_at: Timestamp;
  finished_at: TimestampDefault;
  triggered_by: string | null;
}

export type TestStatusColumn = 'queued' | 'running' | 'ok' | 'failed';

export interface DestinationTestsTable {
  id: Generated<string>;
  kind: 'check' | 'test_send';
  connection_id: string | null;
  destination_id: string | null;
  draft_kind: ConnectionKindColumn | null;
  draft_config: JsonNullable;
  draft_secrets: string | null;
  submission_id: string | null;
  status: Default<TestStatusColumn>;
  result: JsonNullable;
  requested_by: string;
  created_at: TimestampDefault;
  finished_at: Timestamp | null;
}

export interface DeliveryAlertsTable {
  id: Generated<string>;
  kind: 'incident' | 'reminder' | 'recovered' | 'system_email' | 'secret_expiry';
  destination_id: string | null;
  connection_id: string | null;
  recipients: string[];
  items: JsonDefault;
  sent_at: TimestampDefault;
}

export interface ApiKeysTable {
  id: Generated<string>;
  name: string;
  prefix: string;
  key_hash: Bytes;
  scopes: string[];
  all_sites: Default<boolean>;
  form_ids: string[] | null;
  created_by: string;
  created_at: TimestampDefault;
  expires_at: Timestamp | null;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
}

export interface ApiKeyScopesTable {
  api_key_id: string;
  scope_type: 'company' | 'region' | 'site';
  scope_id: string;
}

export interface Database {
  companies: CompaniesTable;
  regions: RegionsTable;
  sites: SitesTable;
  shifts: ShiftsTable;
  employees: EmployeesTable;
  users: UsersTable;
  user_scopes: UserScopesTable;
  sessions: SessionsTable;
  consents: ConsentsTable;
  settings: SettingsTable;
  blobs: BlobsTable;
  register_submissions: RegisterSubmissionsTable;
  attendance_entries: AttendanceEntriesTable;
  attendance_entries_effective: AttendanceEntriesEffectiveView;
  entry_corrections: EntryCorrectionsTable;
  notification_log: NotificationLogTable;
  privacy_requests: PrivacyRequestsTable;
  audit_log: AuditLogTable;
  forms: FormsTable;
  form_versions: FormVersionsTable;
  option_lists: OptionListsTable;
  user_groups: UserGroupsTable;
  user_group_members: UserGroupMembersTable;
  dispatches: DispatchesTable;
  form_submissions: FormSubmissionsTable;
  form_submission_files: FormSubmissionFilesTable;
  output_templates: OutputTemplatesTable;
  output_template_versions: OutputTemplateVersionsTable;
  template_forms: TemplateFormsTable;
  connections: ConnectionsTable;
  connection_revisions: ConnectionRevisionsTable;
  destinations: DestinationsTable;
  destination_revisions: DestinationRevisionsTable;
  rendered_documents: RenderedDocumentsTable;
  delivery_plans: DeliveryPlansTable;
  deliveries: DeliveriesTable;
  delivery_attempts: DeliveryAttemptsTable;
  destination_tests: DestinationTestsTable;
  delivery_alerts: DeliveryAlertsTable;
  api_keys: ApiKeysTable;
  api_key_scopes: ApiKeyScopesTable;
}

export type User = Selectable<UsersTable>;
export type Employee = Selectable<EmployeesTable>;
export type Site = Selectable<SitesTable>;
export type Shift = Selectable<ShiftsTable>;
export type RegisterSubmission = Selectable<RegisterSubmissionsTable>;
export type NewRegisterSubmission = Insertable<RegisterSubmissionsTable>;

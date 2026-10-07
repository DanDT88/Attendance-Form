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
  submission_id: string;
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
  action: string;
  entity: string | null;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: Json | null;
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
}

export type User = Selectable<UsersTable>;
export type Employee = Selectable<EmployeesTable>;
export type Site = Selectable<SitesTable>;
export type Shift = Selectable<ShiftsTable>;
export type RegisterSubmission = Selectable<RegisterSubmissionsTable>;
export type NewRegisterSubmission = Insertable<RegisterSubmissionsTable>;

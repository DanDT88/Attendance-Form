import { formatLocal } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import { ConnectionsAdmin } from './Connections';
import { FormEditor, FormsAdmin, GroupsAdmin, ListsAdmin } from './FormBuilder';

/* Admin screens: deliberately plain forms and tables. Nothing is ever hard-deleted; "Deactivate" hides it. */

interface Company {
  id: string;
  name: string;
  report_recipients: string[];
  deactivated_at: string | null;
}
interface Region {
  id: string;
  name: string;
  company_id: string;
  deactivated_at: string | null;
}
interface Site {
  id: string;
  name: string;
  region_id: string;
  lat: number | null;
  lng: number | null;
  geofence_metres: number;
  report_recipients: string[] | null;
  deactivated_at: string | null;
}
interface Shift {
  id: string;
  site_id: string;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  deactivated_at: string | null;
}
interface Employee {
  id: string;
  employee_no: string;
  first_name: string;
  last_name: string;
  title: string | null;
  site_id: string | null;
  pool_region_id: string | null;
  status: string;
}
interface User {
  id: string;
  role: string;
  display_name: string;
  email: string | null;
  employee_no: string | null;
  active: boolean;
  locked_until: string | null;
  last_login_at: string | null;
  scopes: { type: string; id: string }[];
}

function useList<T>(path: string) {
  return useQuery({ queryKey: ['admin', path], queryFn: () => api<T[]>(path) });
}

function useSave() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = async (path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown) => {
    setError(null);
    try {
      await api(path, { method, body });
      await qc.invalidateQueries({ queryKey: ['admin'] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };
  return { save, error };
}

const fd = (e: FormEvent<HTMLFormElement>) =>
  Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
const list = (s: string | undefined) =>
  (s ?? '')
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function AdminPage() {
  return (
    <div className="stack">
      <nav className="tabs">
        <NavLink to="forms">Forms</NavLink>
        <NavLink to="lists">Lists</NavLink>
        <NavLink to="groups">Groups</NavLink>
        <NavLink to="org">Sites</NavLink>
        <NavLink to="employees">Employees</NavLink>
        <NavLink to="users">Users</NavLink>
        <NavLink to="connections">Connections</NavLink>
        <NavLink to="settings">Settings</NavLink>
        <NavLink to="privacy">Privacy</NavLink>
        <NavLink to="audit">Audit log</NavLink>
      </nav>
      <Routes>
        <Route index element={<Navigate to="org" replace />} />
        <Route path="forms" element={<FormsAdmin />} />
        <Route path="forms/:id" element={<FormEditor />} />
        <Route path="lists" element={<ListsAdmin />} />
        <Route path="groups" element={<GroupsAdmin />} />
        <Route path="org" element={<OrgAdmin />} />
        <Route path="employees" element={<EmployeesAdmin />} />
        <Route path="users" element={<UsersAdmin />} />
        <Route path="connections" element={<ConnectionsAdmin />} />
        <Route path="settings" element={<SettingsAdmin />} />
        <Route path="privacy" element={<PrivacyAdmin />} />
        <Route path="audit" element={<AuditAdmin />} />
      </Routes>
    </div>
  );
}

function OrgAdmin() {
  const companies = useList<Company>('/admin/companies');
  const regions = useList<Region>('/admin/regions');
  const sites = useList<Site>('/admin/sites');
  const shifts = useList<Shift>('/admin/shifts');
  const { save, error } = useSave();
  const toggle = (path: string, deactivated: string | null) =>
    save(path, 'PATCH', { active: !!deactivated });

  return (
    <>
      {error && <p className="error">{error}</p>}
      <Section title="Companies">
        <table className="report">
          <tbody>
            {companies.data?.map((c) => (
              <tr key={c.id} className={c.deactivated_at ? 'inactive' : ''}>
                <td>{c.name}</td>
                <td className="small">
                  {c.report_recipients.join(', ') || (
                    <span className="muted">no report recipients</span>
                  )}
                </td>
                <td>
                  <button
                    className="link small"
                    onClick={() => {
                      const v = prompt(
                        'Report recipients (comma separated)',
                        c.report_recipients.join(', '),
                      );
                      if (v !== null)
                        void save(`/admin/companies/${c.id}`, 'PATCH', {
                          reportRecipients: list(v),
                        });
                    }}
                  >
                    Recipients
                  </button>{' '}
                  <button
                    className="link small"
                    onClick={() => void toggle(`/admin/companies/${c.id}`, c.deactivated_at)}
                  >
                    {c.deactivated_at ? 'Reactivate' : 'Deactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = fd(e);
            const form = e.currentTarget;
            if (
              await save('/admin/companies', 'POST', {
                name: f.name,
                reportRecipients: list(f.recipients),
              })
            )
              form.reset();
          }}
        >
          <input name="name" placeholder="Company name" required />
          <input name="recipients" placeholder="Report recipients (emails)" />
          <button>Add company</button>
        </form>
      </Section>

      <Section title="Regions">
        <table className="report">
          <tbody>
            {regions.data?.map((r) => (
              <tr key={r.id} className={r.deactivated_at ? 'inactive' : ''}>
                <td>{r.name}</td>
                <td className="small">
                  {companies.data?.find((c) => c.id === r.company_id)?.name}
                </td>
                <td>
                  <button
                    className="link small"
                    onClick={() => void toggle(`/admin/regions/${r.id}`, r.deactivated_at)}
                  >
                    {r.deactivated_at ? 'Reactivate' : 'Deactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = fd(e);
            const form = e.currentTarget;
            if (await save('/admin/regions', 'POST', { companyId: f.companyId, name: f.name }))
              form.reset();
          }}
        >
          <select name="companyId" required>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Region name" required />
          <button>Add region</button>
        </form>
      </Section>

      <Section title="Sites and shifts">
        <table className="report">
          <thead>
            <tr>
              <th>Site</th>
              <th>Region</th>
              <th>GPS / radius</th>
              <th>Shifts</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sites.data?.map((s) => (
              <tr key={s.id} className={s.deactivated_at ? 'inactive' : ''}>
                <td>{s.name}</td>
                <td className="small">{regions.data?.find((r) => r.id === s.region_id)?.name}</td>
                <td className="small">
                  {s.lat !== null ? (
                    `${s.lat.toFixed(5)}, ${s.lng?.toFixed(5)} · ${s.geofence_metres} m`
                  ) : (
                    <span className="muted">not set</span>
                  )}
                </td>
                <td className="small">
                  {shifts.data
                    ?.filter((sh) => sh.site_id === s.id)
                    .map((sh) => (
                      <div key={sh.id} className={sh.deactivated_at ? 'inactive' : ''}>
                        {sh.name} {sh.start_time}–{sh.end_time}{' '}
                        <button
                          className="link small"
                          onClick={() => void toggle(`/admin/shifts/${sh.id}`, sh.deactivated_at)}
                        >
                          {sh.deactivated_at ? 'reactivate' : 'deactivate'}
                        </button>
                      </div>
                    ))}
                </td>
                <td className="nowrap">
                  <button
                    className="link small"
                    onClick={() => {
                      const v = prompt(
                        'Latitude, longitude, radius in metres',
                        s.lat !== null ? `${s.lat}, ${s.lng}, ${s.geofence_metres}` : '',
                      );
                      if (!v) return;
                      const [lat, lng, radius] = v.split(',').map((x) => Number(x.trim()));
                      void save(`/admin/sites/${s.id}`, 'PATCH', {
                        lat,
                        lng,
                        ...(radius ? { geofenceMetres: radius } : {}),
                      });
                    }}
                  >
                    Set GPS
                  </button>{' '}
                  <button
                    className="link small"
                    onClick={() => void toggle(`/admin/sites/${s.id}`, s.deactivated_at)}
                  >
                    {s.deactivated_at ? 'Reactivate' : 'Deactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = fd(e);
            const form = e.currentTarget;
            const coords = f.lat && f.lng ? { lat: Number(f.lat), lng: Number(f.lng) } : {};
            if (
              await save('/admin/sites', 'POST', {
                regionId: f.regionId,
                name: f.name,
                ...coords,
                ...(f.radius ? { geofenceMetres: Number(f.radius) } : {}),
              })
            )
              form.reset();
          }}
        >
          <select name="regionId" required>
            {regions.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Site name" required />
          <input name="lat" placeholder="Latitude" inputMode="decimal" />
          <input name="lng" placeholder="Longitude" inputMode="decimal" />
          <input name="radius" placeholder="Radius m" inputMode="numeric" />
          <button>Add site</button>
        </form>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = fd(e);
            const form = e.currentTarget;
            if (
              await save('/admin/shifts', 'POST', {
                siteId: f.siteId,
                name: f.name,
                kind: f.kind,
                startTime: f.startTime,
                endTime: f.endTime,
              })
            )
              form.reset();
          }}
        >
          <select name="siteId" required>
            {sites.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Shift name" required />
          <select name="kind">
            <option value="day">Day</option>
            <option value="night">Night</option>
          </select>
          <input name="startTime" type="time" required />
          <input name="endTime" type="time" required />
          <button>Add shift</button>
        </form>
      </Section>
    </>
  );
}

function EmployeesAdmin() {
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const employees = useList<Employee>(
    `/admin/employees?search=${encodeURIComponent(search)}&includeInactive=${inactive}`,
  );
  const sites = useList<Site>('/admin/sites');
  const regions = useList<Region>('/admin/regions');
  const { save, error } = useSave();
  const siteName = (id: string | null) => sites.data?.find((s) => s.id === id)?.name ?? '';

  return (
    <Section title="Employees">
      {error && <p className="error">{error}</p>}
      <div className="inline-form">
        <input
          placeholder="Search name or number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="inline">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(e) => setInactive(e.target.checked)}
          />{' '}
          Show inactive
        </label>
      </div>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = fd(e);
          const form = e.currentTarget;
          const ok = await save('/admin/employees', 'POST', {
            employeeNo: f.employeeNo,
            firstName: f.firstName,
            lastName: f.lastName,
            title: f.title || null,
            siteId: f.siteId || null,
            poolRegionId: f.poolRegionId || null,
          });
          if (ok) form.reset();
        }}
      >
        <input name="employeeNo" placeholder="Employee no" required />
        <input name="firstName" placeholder="First name" required />
        <input name="lastName" placeholder="Last name" required />
        <input name="title" placeholder="Title" />
        <select name="siteId">
          <option value="">No home site</option>
          {sites.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select name="poolRegionId">
          <option value="">Not in replacement pool</option>
          {regions.data?.map((r) => (
            <option key={r.id} value={r.id}>
              Pool: {r.name}
            </option>
          ))}
        </select>
        <button>Add employee</button>
      </form>
      <div className="scroll">
        <table className="report">
          <thead>
            <tr>
              <th>No</th>
              <th>Name</th>
              <th>Title</th>
              <th>Site</th>
              <th>Pool</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees.data?.map((e) => (
              <tr key={e.id} className={e.status === 'inactive' ? 'inactive' : ''}>
                <td>{e.employee_no}</td>
                <td>
                  {e.first_name} {e.last_name}
                </td>
                <td className="small">{e.title}</td>
                <td className="small">
                  <select
                    value={e.site_id ?? ''}
                    onChange={(ev) =>
                      void save(`/admin/employees/${e.id}`, 'PATCH', {
                        siteId: ev.target.value || null,
                      })
                    }
                  >
                    <option value="">—</option>
                    {sites.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="sr-only">{siteName(e.site_id)}</span>
                </td>
                <td className="small">
                  {regions.data?.find((r) => r.id === e.pool_region_id)?.name ?? ''}
                </td>
                <td>
                  <button
                    className="link small"
                    onClick={() =>
                      void save(`/admin/employees/${e.id}`, 'PATCH', {
                        status: e.status === 'active' ? 'inactive' : 'active',
                      })
                    }
                  >
                    {e.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function UsersAdmin() {
  const users = useList<User>('/admin/users');
  const companies = useList<Company>('/admin/companies');
  const regions = useList<Region>('/admin/regions');
  const sites = useList<Site>('/admin/sites');
  const { save, error } = useSave();
  const [role, setRole] = useState('supervisor');
  const scopeOptions = [
    ...(companies.data ?? []).map((c) => ({
      value: `company:${c.id}`,
      label: `Company: ${c.name}`,
    })),
    ...(regions.data ?? []).map((r) => ({ value: `region:${r.id}`, label: `Region: ${r.name}` })),
    ...(sites.data ?? []).map((s) => ({ value: `site:${s.id}`, label: `Site: ${s.name}` })),
  ];
  const scopeLabel = (s: { type: string; id: string }) =>
    scopeOptions.find((o) => o.value === `${s.type}:${s.id}`)?.label ?? s.type;

  return (
    <Section title="Users">
      {error && <p className="error">{error}</p>}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const scopes = f.getAll('scopes').map((v) => {
            const [type, id] = String(v).split(':');
            return { type, id };
          });
          const ok = await save('/admin/users', 'POST', {
            role,
            displayName: f.get('displayName'),
            email: role === 'supervisor' ? null : f.get('email'),
            employeeNo: role === 'supervisor' ? f.get('employeeNo') : null,
            ...(role === 'supervisor'
              ? { pin: f.get('secret') }
              : f.get('secret')
                ? { password: f.get('secret') }
                : {}),
            scopes,
          });
          if (ok) form.reset();
        }}
      >
        <div className="inline-form">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="supervisor">Supervisor</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
          <input name="displayName" placeholder="Name" required />
          {role === 'supervisor' ? (
            <input name="employeeNo" placeholder="Employee no" required />
          ) : (
            <input name="email" type="email" placeholder="Work email" required />
          )}
          <input
            name="secret"
            type="password"
            placeholder={role === 'supervisor' ? '6-digit PIN' : 'Password (optional with SSO)'}
          />
        </div>
        {role !== 'admin' && (
          <label>
            Access (hold Ctrl/Cmd to choose several)
            <select name="scopes" multiple size={6}>
              {scopeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button>Add user</button>
      </form>
      <div className="scroll">
        <table className="report">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Sign-in</th>
              <th>Access</th>
              <th>Last sign-in</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'inactive'}>
                <td>
                  {u.display_name}
                  {u.locked_until && new Date(u.locked_until) > new Date() && (
                    <span className="flag bad">Locked</span>
                  )}
                </td>
                <td>{u.role}</td>
                <td className="small">{u.email ?? u.employee_no}</td>
                <td className="small">
                  {u.role === 'admin'
                    ? 'Everything'
                    : u.scopes.map(scopeLabel).join(', ') || <span className="error">none</span>}
                </td>
                <td className="small">
                  {u.last_login_at ? formatLocal(u.last_login_at) : 'never'}
                </td>
                <td className="nowrap">
                  <button
                    className="link small"
                    onClick={() => {
                      const v = prompt(
                        u.role === 'supervisor'
                          ? 'New 6-digit PIN'
                          : 'New password (12+ characters)',
                      );
                      if (v)
                        void save(
                          `/admin/users/${u.id}`,
                          'PATCH',
                          u.role === 'supervisor' ? { pin: v } : { password: v },
                        );
                    }}
                  >
                    {u.role === 'supervisor' ? 'Reset PIN' : 'Reset password'}
                  </button>{' '}
                  {u.locked_until && (
                    <button
                      className="link small"
                      onClick={() => void save(`/admin/users/${u.id}`, 'PATCH', { unlock: true })}
                    >
                      Unlock
                    </button>
                  )}{' '}
                  <button
                    className="link small"
                    onClick={() =>
                      void save(`/admin/users/${u.id}`, 'PATCH', { active: !u.active })
                    }
                  >
                    {u.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function SettingsAdmin() {
  const q = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api<Record<string, string | number>>('/admin/settings'),
  });
  const { save, error } = useSave();
  const [saved, setSaved] = useState(false);
  if (!q.data) return null;
  const s = q.data;
  const num = (name: string, label: string, help: string) => (
    <label>
      {label}
      <input name={name} type="number" defaultValue={s[name]} required />
      <span className="small muted">{help}</span>
    </label>
  );
  return (
    <Section title="Settings">
      {error && <p className="error">{error}</p>}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = fd(e);
          setSaved(false);
          const ok = await save('/admin/settings', 'PUT', {
            clockSkewThresholdSeconds: Number(f.clockSkewThresholdSeconds),
            syncDelayFlagHours: Number(f.syncDelayFlagHours),
            shiftGraceMinutes: Number(f.shiftGraceMinutes),
            defaultGeofenceMetres: Number(f.defaultGeofenceMetres),
            attendanceRetentionYears: Number(f.attendanceRetentionYears),
            privacyNoticeVersion: f.privacyNoticeVersion,
            privacyNoticeText: f.privacyNoticeText,
          });
          setSaved(ok);
        }}
      >
        {num(
          'clockSkewThresholdSeconds',
          'Clock skew threshold (seconds)',
          'Flag registers whose device clock differs from the server by more than this.',
        )}
        {num(
          'syncDelayFlagHours',
          'Late sync flag (hours)',
          'Flag registers that reached the server more than this long after capture.',
        )}
        {num(
          'shiftGraceMinutes',
          'Shift time window (minutes)',
          'Registers taken more than this far from shift start/end are flagged.',
        )}
        {num('defaultGeofenceMetres', 'Default site radius (metres)', 'Used for new sites.')}
        {num(
          'attendanceRetentionYears',
          'Attendance retention (years)',
          'At least 3 (BCEA), counted from the last entry.',
        )}
        <label>
          Privacy notice version
          <input name="privacyNoticeVersion" defaultValue={s.privacyNoticeVersion} required />
          <span className="small muted">
            Change the version to ask everyone to accept the notice again.
          </span>
        </label>
        <label>
          Privacy notice text
          <textarea
            name="privacyNoticeText"
            rows={10}
            defaultValue={s.privacyNoticeText}
            required
          />
        </label>
        <button>Save settings</button>
        {saved && <p className="ok">Saved.</p>}
      </form>
    </Section>
  );
}

function PrivacyAdmin() {
  const [search, setSearch] = useState('');
  const employees = useList<Employee>(
    `/admin/employees?search=${encodeURIComponent(search)}&includeInactive=true`,
  );
  const requests = useList<{
    id: string;
    kind: string;
    status: string;
    decision_reason: string | null;
    created_at: string;
    employee_no: string;
    requested_by: string;
  }>('/privacy/requests');
  const retention = useQuery({
    queryKey: ['admin', 'retention'],
    queryFn: () =>
      api<{
        retentionYears: number;
        employees: {
          id: string;
          employee_no: string;
          name: string;
          last_entry: string;
          eligibleFrom: string;
        }[];
      }>('/admin/retention'),
  });
  const qc = useQueryClient();
  const [result, setResult] = useState<string | null>(null);

  return (
    <>
      <Section title="Access and deletion requests (POPIA)">
        {result && <p className="ok">{result}</p>}
        <input
          placeholder="Find employee"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <table className="report">
          <tbody>
            {search &&
              employees.data?.slice(0, 20).map((e) => (
                <tr key={e.id}>
                  <td>{e.employee_no}</td>
                  <td>
                    {e.first_name} {e.last_name}
                  </td>
                  <td className="nowrap">
                    <a className="small" href={`/api/privacy/employees/${e.id}/export`}>
                      Export their data
                    </a>{' '}
                    <button
                      className="link small"
                      onClick={async () => {
                        if (
                          !confirm(
                            `Request deletion for ${e.first_name} ${e.last_name}? This is refused while attendance must be retained.`,
                          )
                        )
                          return;
                        setResult(null);
                        try {
                          const r = await api<{ status: string; reason: string }>(
                            `/privacy/employees/${e.id}/delete`,
                            { method: 'POST' },
                          );
                          setResult(
                            `${r.status === 'completed' ? 'Done' : 'Refused'}: ${r.reason}`,
                          );
                          await qc.invalidateQueries({ queryKey: ['admin'] });
                        } catch (err) {
                          setResult((err as Error).message);
                        }
                      }}
                    >
                      Request deletion
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <h4>History</h4>
        <table className="report">
          <tbody>
            {requests.data?.map((r) => (
              <tr key={r.id}>
                <td className="small">{formatLocal(r.created_at)}</td>
                <td>{r.employee_no}</td>
                <td>{r.kind}</td>
                <td>{r.status}</td>
                <td className="small">{r.decision_reason}</td>
                <td className="small">{r.requested_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section
        title={`Past retention (${retention.data?.retentionYears ?? 3} years from last entry)`}
      >
        {!retention.data?.employees.length ? (
          <p className="muted">No employees are past the retention period.</p>
        ) : (
          <table className="report">
            <tbody>
              {retention.data.employees.map((e) => (
                <tr key={e.id}>
                  <td>{e.employee_no}</td>
                  <td>{e.name}</td>
                  <td>last entry {e.last_entry}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function AuditAdmin() {
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: () =>
      api<
        {
          id: number;
          at: string;
          action: string;
          entity: string | null;
          entity_id: string | null;
          ip: string | null;
          actor: string | null;
          details: unknown;
        }[]
      >(`/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <Section title="Audit log">
      <select value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">Everything</option>
        <option value="attendance.">Attendance views, exports and corrections</option>
        <option value="auth.">Sign-ins</option>
        <option value="register.">Registers</option>
        <option value="admin.">Admin changes</option>
        <option value="privacy.">Privacy</option>
      </select>
      <div className="scroll">
        <table className="report">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((a) => (
              <tr key={a.id}>
                <td className="small nowrap">{formatLocal(a.at, 'yyyy-MM-dd HH:mm:ss')}</td>
                <td className="small">
                  {a.actor ?? '—'}
                  <div className="muted">{a.ip}</div>
                </td>
                <td className="small">{a.action}</td>
                <td className="small">
                  {a.entity} {a.entity_id?.slice(0, 8)}
                </td>
                <td className="small mono">
                  {a.details ? JSON.stringify(a.details).slice(0, 160) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

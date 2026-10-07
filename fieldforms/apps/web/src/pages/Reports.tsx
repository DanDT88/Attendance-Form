import { formatLocal, localDate } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

interface Org {
  companies: { id: string; name: string }[];
  regions: { id: string; name: string; company_id: string }[];
  sites: { id: string; name: string; region_id: string }[];
  shifts: { id: string; site_id: string; name: string; start_time: string; end_time: string }[];
}

interface Row {
  workDate: string;
  employeeId: string;
  employeeNo: string;
  employeeName: string;
  site: string;
  siteId: string;
  shift: string | null;
  firstIn: string | null;
  lastOut: string | null;
  hoursWorked: number | null;
  status: string;
  minutesLate: number | null;
  minutesEarly: number | null;
  reasons: string[];
  replacement: string | null;
  submissionIds: string[];
  flags: Record<string, boolean>;
}

const FLAG_TEXT: Record<string, [string, 'bad' | 'warn' | 'info']> = {
  missingIn: ['Missing IN', 'bad'],
  missingOut: ['Missing OUT', 'bad'],
  absent: ['Absent', 'bad'],
  late: ['Late', 'warn'],
  leftEarly: ['Left early', 'warn'],
  clockSkew: ['Clock skew', 'bad'],
  syncDelay: ['Late sync', 'info'],
  outsideGeofence: ['Outside site', 'warn'],
  outsideShiftTime: ['Outside shift time', 'info'],
  corrected: ['Corrected', 'info'],
  legacy: ['Legacy', 'info'],
};

export function ReportsPage() {
  const today = localDate(new Date());
  const [filter, setFilter] = useState({ from: today, to: today, companyId: '', regionId: '', siteId: '' });
  const [missingOnly, setMissingOnly] = useState(false);
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<Org>('/meta/org') });
  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: filter.from, to: filter.to });
    if (filter.companyId) p.set('companyId', filter.companyId);
    if (filter.regionId) p.set('regionId', filter.regionId);
    if (filter.siteId) p.set('siteId', filter.siteId);
    return p.toString();
  }, [filter]);
  const report = useQuery({ queryKey: ['report', qs], queryFn: () => api<{ rows: Row[] }>(`/reports/daily?${qs}`) });
  const rows = (report.data?.rows ?? []).filter((r) => !missingOnly || r.flags.missingIn || r.flags.missingOut);

  const regions = (org.data?.regions ?? []).filter((r) => !filter.companyId || r.company_id === filter.companyId);
  const sites = (org.data?.sites ?? []).filter((s) => (!filter.regionId ? regions.some((r) => r.id === s.region_id) : s.region_id === filter.regionId));

  return (
    <div className="stack">
      <div className="card filters">
        <label>
          From <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
        </label>
        <label>
          To <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
        </label>
        <label>
          Company
          <select value={filter.companyId} onChange={(e) => setFilter({ ...filter, companyId: e.target.value, regionId: '', siteId: '' })}>
            <option value="">All</option>
            {org.data?.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Region
          <select value={filter.regionId} onChange={(e) => setFilter({ ...filter, regionId: e.target.value, siteId: '' })}>
            <option value="">All</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Site
          <select value={filter.siteId} onChange={(e) => setFilter({ ...filter, siteId: e.target.value })}>
            <option value="">All</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> Missing clock events only
        </label>
        <div className="actions">
          <a className="button secondary" href={`/api/reports/daily/export.xlsx?${qs}`}>
            Export XLSX
          </a>
          <a className="button secondary" href={`/api/reports/daily/export.csv?${qs}`}>
            Export CSV
          </a>
        </div>
      </div>

      {report.isLoading && <p className="muted">Loading…</p>}
      {report.error && <p className="error">{(report.error as Error).message}</p>}
      {report.data && (
        <div className="card scroll">
          <p className="muted small">
            {rows.length} rows · times in South African time (SAST) · hours = last OUT − first IN
          </p>
          <table className="report" data-testid="report">
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Site / shift</th>
                <th>First in</th>
                <th>Last out</th>
                <th>Hours</th>
                <th>Status</th>
                <th>Flags</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ReportRow key={`${r.workDate}-${r.employeeId}`} r={r} org={org.data} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReportRow({ r, org }: { r: Row; org: Org | undefined }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <tr>
        <td>{r.workDate}</td>
        <td>
          {r.employeeName}
          <div className="muted small">{r.employeeNo}</div>
        </td>
        <td>
          {r.site}
          <div className="muted small">{r.shift}</div>
        </td>
        <td>{r.firstIn ? formatLocal(r.firstIn, 'HH:mm') : '—'}</td>
        <td>{r.lastOut ? formatLocal(r.lastOut, r.lastOut.slice(0, 10) === r.firstIn?.slice(0, 10) ? 'HH:mm' : 'dd MMM HH:mm') : '—'}</td>
        <td>{r.hoursWorked ?? '—'}</td>
        <td>
          {r.status.replace(/_/g, ' ')}
          {r.minutesLate ? <div className="small muted">{r.minutesLate} min late</div> : null}
          {r.minutesEarly ? <div className="small muted">{r.minutesEarly} min early</div> : null}
          {r.replacement ? <div className="small muted">Replaced by {r.replacement}</div> : null}
        </td>
        <td>
          {Object.entries(r.flags)
            .filter(([, v]) => v)
            .map(([k]) => (
              <span key={k} className={`flag ${FLAG_TEXT[k]?.[1] ?? 'info'}`}>
                {FLAG_TEXT[k]?.[0] ?? k}
              </span>
            ))}
        </td>
        <td className="nowrap">
          {r.submissionIds.map((id, i) => (
            <Link key={id} to={`/registers/${id}`} className="small">
              Register {i + 1}
            </Link>
          ))}
          {(r.flags.missingOut || r.flags.missingIn) && (
            <button className="link small" onClick={() => setAdding(!adding)}>
              Add missing {r.flags.missingOut ? 'OUT' : 'IN'}
            </button>
          )}
        </td>
      </tr>
      {adding && (
        <tr>
          <td colSpan={9}>
            <ManualEventForm r={r} org={org} event={r.flags.missingOut ? 'out' : 'in'} onDone={() => setAdding(false)} />
          </td>
        </tr>
      )}
    </>
  );
}

function ManualEventForm({ r, org, event, onDone }: { r: Row; org: Org | undefined; event: 'in' | 'out'; onDone(): void }) {
  const qc = useQueryClient();
  const shifts = (org?.shifts ?? []).filter((s) => s.site_id === r.siteId);
  const [shiftId, setShiftId] = useState(shifts.find((s) => s.name === r.shift)?.id ?? shifts[0]?.id ?? '');
  const shift = shifts.find((s) => s.id === shiftId);
  const [time, setTime] = useState(event === 'out' ? (shift?.end_time ?? '') : (shift?.start_time ?? ''));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/registers/manual', {
            method: 'POST',
            body: { employeeId: r.employeeId, siteId: r.siteId, shiftId, workDate: r.workDate, event, time, reason },
          });
          await qc.invalidateQueries({ queryKey: ['report'] });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <b>Add {event.toUpperCase()} for {r.employeeName}</b>
      <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
        {shifts.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
      <input required minLength={3} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit">Save</button>
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

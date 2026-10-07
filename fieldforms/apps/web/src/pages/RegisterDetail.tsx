import { formatLocal, localTime } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

interface Entry {
  id: string;
  employee_name: string;
  employee_no: string;
  status: string;
  event: 'in' | 'out' | null;
  event_at: string | null;
  minutes: number | null;
  reason: string | null;
  replacement_name: string | null;
  corrected: boolean;
}

interface Correction {
  id: string;
  entry_id: string;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  reason: string;
  corrected_at: string;
  corrected_by_name: string;
}

interface Submission {
  kind: string;
  site_name: string;
  shift_name: string | null;
  work_date: string;
  submitted_by_name: string | null;
  sign_off_name: string | null;
  device_captured_at: string | null;
  server_received_at: string;
  clock_skew_flag: boolean;
  clock_skew_seconds: number | null;
  sync_delay_flag: boolean;
  sync_delay_seconds: number | null;
  geo_ok: boolean | null;
  distance_metres: number | null;
  time_ok: boolean | null;
  reason: string | null;
  supervisor_photo_id: string | null;
  staff_photo_id: string | null;
}

interface Detail {
  submission: Submission;
  entries: Entry[];
  corrections: Correction[];
}

const yesNo = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'NO');

export function RegisterDetailPage() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['register', id],
    queryFn: () => api<Detail>(`/registers/${id}`),
  });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error || !q.data)
    return <p className="error">{(q.error as Error)?.message ?? 'Not found'}</p>;
  const { submission: s, entries, corrections } = q.data;

  return (
    <div className="stack">
      <div className="card">
        <h2>
          {s.kind.replace('_', ' ')} register · {s.site_name} · {s.work_date}
        </h2>
        <dl className="facts">
          <dt>Shift</dt>
          <dd>{s.shift_name ?? '—'}</dd>
          <dt>Submitted by</dt>
          <dd>
            {s.submitted_by_name}
            {s.sign_off_name ? ` (sign-off: ${s.sign_off_name})` : ''}
          </dd>
          <dt>Captured on device</dt>
          <dd>
            {s.device_captured_at ? formatLocal(s.device_captured_at, 'yyyy-MM-dd HH:mm:ss') : '—'}
          </dd>
          <dt>Received by server</dt>
          <dd>
            {formatLocal(s.server_received_at, 'yyyy-MM-dd HH:mm:ss')}
            {s.clock_skew_flag && (
              <span className="flag bad">
                Device clock off by {Math.round((s.clock_skew_seconds ?? 0) / 60)} min
              </span>
            )}
            {s.sync_delay_flag && (
              <span className="flag info">
                Synced {Math.round((s.sync_delay_seconds ?? 0) / 3600)} h later
              </span>
            )}
          </dd>
          <dt>On site</dt>
          <dd>
            {yesNo(s.geo_ok)}
            {s.distance_metres !== null ? ` (${s.distance_metres} m from site)` : ''}
          </dd>
          <dt>Within shift time</dt>
          <dd>{yesNo(s.time_ok)}</dd>
          {s.reason && (
            <>
              <dt>Reason</dt>
              <dd>{s.reason}</dd>
            </>
          )}
        </dl>
        <div className="photos">
          {s.supervisor_photo_id && (
            <img src={`/api/blobs/${s.supervisor_photo_id}`} alt="Supervisor" />
          )}
          {s.staff_photo_id && <img src={`/api/blobs/${s.staff_photo_id}`} alt="Staff" />}
        </div>
      </div>

      <div className="card scroll">
        <table className="report">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Status</th>
              <th>Event</th>
              <th>Detail</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                e={e}
                registerId={id!}
                history={corrections.filter((c) => c.entry_id === e.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EntryRow({
  e,
  registerId,
  history,
}: {
  e: Entry;
  registerId: string;
  history: Correction[];
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  return (
    <>
      <tr>
        <td>
          {e.employee_name}
          <div className="small muted">{e.employee_no}</div>
        </td>
        <td>
          {e.status.replace('_', ' ')}
          {e.corrected && <span className="flag info">Corrected</span>}
        </td>
        <td>
          {e.event
            ? `${e.event.toUpperCase()} ${e.event_at ? formatLocal(e.event_at, 'dd MMM HH:mm') : ''}`
            : '—'}
        </td>
        <td>
          {e.minutes !== null && <div className="small">{e.minutes} min</div>}
          {e.reason && <div className="small">{e.reason}</div>}
          {e.replacement_name && <div className="small">Replaced by {e.replacement_name}</div>}
        </td>
        <td className="nowrap">
          <button className="link small" onClick={() => setEditing(!editing)}>
            Correct
          </button>
          {!!history.length && (
            <button className="link small" onClick={() => setShowHistory(!showHistory)}>
              History ({history.length})
            </button>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <CorrectionForm e={e} registerId={registerId} onDone={() => setEditing(false)} />
          </td>
        </tr>
      )}
      {showHistory && (
        <tr>
          <td colSpan={5}>
            <ol className="history">
              {history.map((c) => (
                <li key={c.id}>
                  <b>{formatLocal(c.corrected_at)}</b> by {c.corrected_by_name}: “{c.reason}”
                  <div className="small muted">
                    {Object.keys(c.new_values)
                      .filter(
                        (k) => JSON.stringify(c.new_values[k]) !== JSON.stringify(c.old_values[k]),
                      )
                      .map(
                        (k) =>
                          `${k}: ${String(c.old_values[k] ?? '—')} → ${String(c.new_values[k] ?? '—')}`,
                      )
                      .join(' · ')}
                  </div>
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

function CorrectionForm({
  e,
  registerId,
  onDone,
}: {
  e: Entry;
  registerId: string;
  onDone(): void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(e.status);
  const originalTime = e.event_at ? localTime(new Date(e.event_at)) : '';
  const [time, setTime] = useState(originalTime);
  const [minutes, setMinutes] = useState(e.minutes?.toString() ?? '');
  const [note, setNote] = useState(e.reason ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="inline-form"
      onSubmit={async (ev) => {
        ev.preventDefault();
        const changes: Record<string, unknown> = {
          status,
          reason: note || null,
          minutes: minutes ? Number(minutes) : null,
        };
        // The server turns the local time into an instant using the register's shift and work
        // date, so night-shift times after midnight land on the right day.
        const body: Record<string, unknown> = { changes, reason };
        if (status !== 'absent' && time && time !== originalTime) body.time = time;
        try {
          await api(`/entries/${e.id}/corrections`, { method: 'POST', body });
          await qc.invalidateQueries({ queryKey: ['register', registerId] });
          await qc.invalidateQueries({ queryKey: ['report'] });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <select value={status} onChange={(ev) => setStatus(ev.target.value)}>
        <option value="present">Present</option>
        <option value="late">Late</option>
        <option value="absent">Absent</option>
        <option value="left_early">Left early</option>
      </select>
      {status !== 'absent' && (
        <label className="inline small">
          {status === 'left_early' || e.event === 'out' ? 'Left at' : 'Arrived at'}
          <input
            type="time"
            value={time}
            required={!e.event_at}
            onChange={(ev) => setTime(ev.target.value)}
          />
        </label>
      )}
      <input
        type="number"
        min={0}
        placeholder="Minutes"
        value={minutes}
        onChange={(ev) => setMinutes(ev.target.value)}
      />
      <input placeholder="Note" value={note} onChange={(ev) => setNote(ev.target.value)} />
      <input
        required
        minLength={3}
        placeholder="Reason for correction (required)"
        value={reason}
        onChange={(ev) => setReason(ev.target.value)}
      />
      <button type="submit">Save correction</button>
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

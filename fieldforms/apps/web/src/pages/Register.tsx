import { defaultWorkDate, type EntryStatus } from '@fieldforms/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Bootstrap } from '../lib/api';
import { refreshBootstrap, useAuth } from '../lib/auth';
import { compressPhoto, nowHHmm, readLocationOnce } from '../lib/device';
import { cacheGet, enqueue, localDb, type BlobRow } from '../offline/db';
import { requestSync } from '../offline/sync';

type Kind = 'start' | 'late' | 'left_early' | 'end';
const KIND_LABEL: Record<Kind, string> = { start: 'Start of shift', late: 'Late arrival', left_early: 'Left early', end: 'End of shift' };

interface Line {
  status: EntryStatus | 'skip';
  minutesLate?: string;
  time?: string;
  reason?: string;
  replacementEmployeeId?: string;
}

export function RegisterPage() {
  const { me } = useAuth();
  const boot = useLiveQuery(() => cacheGet<Bootstrap>('bootstrap'), []);
  const [siteId, setSiteId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [kind, setKind] = useState<Kind>('start');
  const [workDate, setWorkDate] = useState('');
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [single, setSingle] = useState<{ employeeId: string; time: string; reason: string }>({ employeeId: '', time: nowHHmm(), reason: '' });
  const [endTime, setEndTime] = useState(nowHHmm());
  const [signOff, setSignOff] = useState('');
  const [supPhoto, setSupPhoto] = useState<Blob | null>(null);
  const [staffPhoto, setStaffPhoto] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const sites = useMemo(() => boot?.sites ?? [], [boot]);
  const site = sites.find((s) => s.id === siteId);
  const shifts = useMemo(() => (boot?.shifts ?? []).filter((s) => s.site_id === siteId), [boot, siteId]);
  const shift = shifts.find((s) => s.id === shiftId);
  const roster = useMemo(() => (boot?.employees ?? []).filter((e) => e.site_id === siteId), [boot, siteId]);
  const pool = useMemo(() => (boot?.pool ?? []).filter((p) => p.pool_region_id === site?.region_id), [boot, site]);

  // Sensible defaults: the only site, the first shift, today's (or last night's) work date.
  useEffect(() => {
    if (!siteId && sites.length === 1) setSiteId(sites[0]!.id);
  }, [sites, siteId]);
  useEffect(() => {
    if (shifts.length && !shifts.some((s) => s.id === shiftId)) setShiftId(shifts[0]!.id);
  }, [shifts, shiftId]);
  useEffect(() => {
    if (shift) setWorkDate(defaultWorkDate({ startTime: shift.start_time, endTime: shift.end_time }, new Date()));
  }, [shift]);

  // Registers already captured on this phone for this site, shift and date (any kind).
  const capturedHere = useLiveQuery(async () => {
    if (!siteId || !shiftId || !workDate) return [];
    const items = await localDb.outbox.toArray();
    return items
      .map((i) => i.payload as { kind: string; siteId: string; shiftId: string; workDate: string; entries: { employeeId: string; status: string }[] })
      .filter((p) => p.siteId === siteId && p.shiftId === shiftId && p.workDate === workDate);
  }, [siteId, shiftId, workDate]);

  // Who was on this shift according to the start register captured here, to pre-fill End of shift.
  const startedKey = useMemo(() => {
    const start = (capturedHere ?? []).filter((p) => p.kind === 'start').at(-1);
    return start ? start.entries.filter((e) => e.status !== 'absent').map((e) => e.employeeId).sort().join(',') : '';
  }, [capturedHere]);

  // Reset the form only when what it is for changes. Keyed on values, not object identity, so a
  // background roster refresh or a new outbox item does not wipe what the supervisor has entered.
  const formKey = `${siteId}|${shiftId}|${workDate}|${kind}|${roster.map((e) => e.id).join(',')}|${kind === 'end' ? startedKey : ''}`;
  const [appliedKey, setAppliedKey] = useState('');
  if (formKey !== appliedKey) {
    setAppliedKey(formKey);
    const started = startedKey ? new Set(startedKey.split(',')) : null;
    const next: Record<string, Line> = {};
    for (const e of roster) {
      if (kind === 'start') next[e.id] = { status: 'present' };
      else if (kind === 'end') next[e.id] = { status: !started || started.has(e.id) ? 'present' : 'skip', time: nowHHmm() };
    }
    setLines(next);
    setSingle({ employeeId: '', time: nowHHmm(), reason: '' });
    setEndTime(nowHHmm());
    setMessage(null);
  }

  if (!boot) {
    return (
      <div className="card">
        <p>This phone has no roster yet. Connect to the internet once so it can download your sites and staff.</p>
        <button onClick={() => void refreshBootstrap()}>Try again</button>
      </div>
    );
  }
  if (!sites.length) return <div className="card">You are not assigned to any site. Ask an administrator.</div>;

  const setLine = (id: string, patch: Partial<Line>) => setLines((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));

  function buildEntries(): { entries: Record<string, unknown>[]; error?: string } {
    if (kind === 'late' || kind === 'left_early') {
      if (!single.employeeId) return { entries: [], error: 'Choose the employee' };
      return {
        entries: [
          {
            employeeId: single.employeeId,
            status: kind,
            time: single.time,
            reason: single.reason || undefined,
          },
        ],
      };
    }
    const entries = [];
    for (const e of roster) {
      const l = lines[e.id];
      if (!l || l.status === 'skip') continue;
      const entry: Record<string, unknown> = { employeeId: e.id, status: l.status, reason: l.reason || undefined };
      if (l.status === 'late') {
        const m = Number(l.minutesLate);
        if (!m || m < 1) return { entries: [], error: `Minutes late for ${e.first_name} ${e.last_name}` };
        entry.minutesLate = m;
      }
      if (l.status === 'left_early') {
        if (!l.time) return { entries: [], error: `Time ${e.first_name} left` };
        entry.time = l.time;
      }
      if (l.status === 'absent' && l.replacementEmployeeId) entry.replacementEmployeeId = l.replacementEmployeeId;
      entries.push(entry);
    }
    if (!entries.length) return { entries: [], error: 'Nobody is on this register' };
    return { entries };
  }

  async function submit() {
    if (!me || !site || !shift) return;
    const { entries, error } = buildEntries();
    if (error) {
      setMessage({ ok: false, text: error });
      return;
    }
    if (
      (kind === 'start' || kind === 'end') &&
      capturedHere?.some((p) => p.kind === kind) &&
      !confirm(`A ${KIND_LABEL[kind].toLowerCase()} register for this shift and date is already saved on this phone. Submit another one?`)
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const capturedAt = new Date();
      // The one and only GPS read: at the moment of submitting.
      const location = await readLocationOnce();
      const photos: BlobRow[] = [];
      const addPhoto = async (b: Blob | null) => {
        if (!b) return null;
        const data = await compressPhoto(b);
        const id = crypto.randomUUID();
        photos.push({ id, data, contentType: 'image/jpeg' });
        return id;
      };
      const supervisorPhotoId = await addPhoto(supPhoto);
      const staffPhotoId = await addPhoto(staffPhoto);
      const id = crypto.randomUUID();
      await enqueue(
        {
          id,
          type: 'register',
          ownerId: me.id,
          label: `${KIND_LABEL[kind]} · ${site.name} · ${workDate} · ${entries.length} staff`,
          payload: {
            id,
            kind,
            siteId: site.id,
            shiftId: shift.id,
            workDate,
            ...(kind === 'end' ? { endTime } : {}),
            signOffName: signOff || undefined,
            deviceCapturedAt: capturedAt.toISOString(),
            location,
            supervisorPhotoId,
            staffPhotoId,
            entries,
          },
        },
        photos,
      );
      requestSync();
      setSupPhoto(null);
      setStaffPhoto(null);
      setMessage({
        ok: true,
        text: `Saved${location ? '' : ' (no GPS fix)'}. ${navigator.onLine ? 'Sending now.' : 'It will be sent when you have signal.'}`,
      });
    } catch (err) {
      setMessage({ ok: false, text: `Could not save: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="grid2">
          <label>
            Site
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} data-testid="site">
              <option value="">Choose…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.company_name})
                </option>
              ))}
            </select>
          </label>
          <label>
            Shift
            <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} data-testid="shift">
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.start_time}–{s.end_time}
                </option>
              ))}
            </select>
          </label>
          <label>
            Work date
            <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} data-testid="work-date" />
          </label>
        </div>
        <div className="tabs">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {site && shift && (
        <>
          {(kind === 'late' || kind === 'left_early') && (
            <div className="card stack">
              <label>
                Employee
                <select value={single.employeeId} onChange={(e) => setSingle({ ...single, employeeId: e.target.value })}>
                  <option value="">Choose…</option>
                  {roster.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.last_name}, {e.first_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {kind === 'late' ? 'Arrived at' : 'Left at'}
                <input type="time" value={single.time} onChange={(e) => setSingle({ ...single, time: e.target.value })} />
              </label>
              <label>
                Reason
                <input value={single.reason} onChange={(e) => setSingle({ ...single, reason: e.target.value })} maxLength={500} />
              </label>
            </div>
          )}

          {(kind === 'start' || kind === 'end') && (
            <div className="card">
              {kind === 'end' && (
                <label className="inline">
                  Shift ended at <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </label>
              )}
              <ul className="roster">
                {roster.map((e) => {
                  const l = lines[e.id] ?? { status: 'present' };
                  const options: (EntryStatus | 'skip')[] = kind === 'start' ? ['present', 'late', 'absent'] : ['present', 'left_early', 'skip'];
                  return (
                    <li key={e.id} data-testid={`row-${e.employee_no}`}>
                      <div className="who">
                        <b>
                          {e.first_name} {e.last_name}
                        </b>
                        <span className="muted">{e.title ?? ''}</span>
                      </div>
                      <div className="seg">
                        {options.map((o) => (
                          <button key={o} className={l.status === o ? `on ${o}` : ''} onClick={() => setLine(e.id, { status: o })}>
                            {o === 'present' ? (kind === 'end' ? 'Stayed' : 'Present') : o === 'late' ? 'Late' : o === 'absent' ? 'Absent' : o === 'left_early' ? 'Left early' : 'Not on shift'}
                          </button>
                        ))}
                      </div>
                      {l.status === 'late' && (
                        <div className="extra">
                          <input type="number" min={1} placeholder="Minutes late" value={l.minutesLate ?? ''} onChange={(ev) => setLine(e.id, { minutesLate: ev.target.value })} />
                          <input placeholder="Reason" value={l.reason ?? ''} onChange={(ev) => setLine(e.id, { reason: ev.target.value })} />
                        </div>
                      )}
                      {l.status === 'absent' && (
                        <div className="extra">
                          <input placeholder="Reason" value={l.reason ?? ''} onChange={(ev) => setLine(e.id, { reason: ev.target.value })} />
                          <select value={l.replacementEmployeeId ?? ''} onChange={(ev) => setLine(e.id, { replacementEmployeeId: ev.target.value || undefined })}>
                            <option value="">No replacement</option>
                            {pool.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.first_name} {p.last_name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {l.status === 'left_early' && (
                        <div className="extra">
                          <input type="time" value={l.time ?? ''} onChange={(ev) => setLine(e.id, { time: ev.target.value })} />
                          <input placeholder="Reason" value={l.reason ?? ''} onChange={(ev) => setLine(e.id, { reason: ev.target.value })} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="card stack">
            <label>
              Supervisor sign-off name
              <input value={signOff} onChange={(e) => setSignOff(e.target.value)} maxLength={120} />
            </label>
            <div className="grid2">
              <label>
                Supervisor photo
                <input type="file" accept="image/*" capture="user" onChange={(e) => setSupPhoto(e.target.files?.[0] ?? null)} />
              </label>
              <label>
                Staff photo
                <input type="file" accept="image/*" capture="environment" onChange={(e) => setStaffPhoto(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <p className="muted small">Your location is read once, when you press Submit, to confirm the register was taken on site.</p>
            <button onClick={() => void submit()} disabled={busy} data-testid="submit">
              {busy ? 'Saving…' : `Submit ${KIND_LABEL[kind].toLowerCase()}`}
            </button>
            {message && (
              <p className={message.ok ? 'ok' : 'error'} data-testid="submit-message">
                {message.text} {message.ok && <Link to="/outbox">View outbox</Link>}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

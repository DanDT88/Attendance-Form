import {
  DELIVERY_STATUSES,
  DESTINATION_LABELS,
  formatLocal,
  type DeliveryStatus,
} from '@fieldforms/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Facts, HealthText, StatusFlag } from '../components/outputs/common';
import { canResend, canRetryNow, OUTCOME_LABELS, STATUS_LABELS } from '../components/outputs/logic';
import {
  api,
  deliveriesApi,
  type DeliveryFilters,
  type DeliveryRow,
  type PublishedForm,
} from '../lib/api';
import { useAuth } from '../lib/auth';

/*
 * The delivery log for the office: where submissions went, what failed and why, and the
 * buttons to send again. Managers see deliveries of submissions they can view; only admins
 * see technical detail, targets and evidence (the server leaves them out for managers).
 */

const when = (d: string | null | undefined) => (d ? formatLocal(d) : '—');

export function DeliveriesPage() {
  const { me } = useAuth();
  const admin = me?.role === 'admin';
  const [tab, setTab] = useState<'deliveries' | 'system'>('deliveries');
  return (
    <div className="stack">
      {admin && (
        <nav className="tabs" aria-label="Delivery log">
          <button
            type="button"
            className={tab === 'deliveries' ? 'active' : ''}
            onClick={() => setTab('deliveries')}
          >
            Deliveries
          </button>
          <button
            type="button"
            className={tab === 'system' ? 'active' : ''}
            data-testid="system-emails-tab"
            onClick={() => setTab('system')}
          >
            System emails
          </button>
        </nav>
      )}
      {tab === 'system' && admin ? <SystemEmails /> : <DeliveryLog admin={admin} />}
    </div>
  );
}

function DeliveryLog({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<DeliveryFilters>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const summary = useQuery({ queryKey: ['deliveries', 'summary'], queryFn: deliveriesApi.summary });
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => api<PublishedForm[]>('/forms') });
  const list = useInfiniteQuery({
    queryKey: ['deliveries', 'list', filters],
    queryFn: ({ pageParam }) => deliveriesApi.list({ ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.rows) ?? [], [list.data]);

  // Admins pick from every destination; managers from those in what they can see.
  const destinations = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of summary.data?.destinations ?? []) m.set(d.id, `${d.formName}: ${d.name}`);
    for (const r of rows) if (!m.has(r.destinationId)) m.set(r.destinationId, r.destinationName);
    return [...m];
  }, [summary.data, rows]);

  const set = (patch: Partial<DeliveryFilters>) => {
    setSelected(new Set());
    setFilters((f) => ({ ...f, ...patch }));
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['deliveries'] });
  const act = async (fn: () => Promise<string>) => {
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
      await refresh();
    } catch (err) {
      setError(err);
    }
  };
  const resendOne = (id: string) =>
    act(async () => {
      const r = await deliveriesApi.resend(id);
      return r.resent ? 'Queued to send again.' : `Not resent: ${r.reason ?? 'not possible now'}`;
    });
  const retryNow = (id: string) =>
    act(async () => {
      const r = await deliveriesApi.retryNow(id);
      return r.ok ? 'Retrying now.' : 'It is no longer waiting to retry.';
    });
  const resendSelected = () =>
    act(async () => {
      const r = await deliveriesApi.resendMany([...selected]);
      setSelected(new Set());
      return `${r.resent} queued to send again${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`;
    });
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const resendable = rows.filter((r) => canResend(r.status));
  const allSelected = resendable.length > 0 && resendable.every((r) => selected.has(r.id));

  return (
    <>
      <section className="card stack" data-testid="deliveries-summary">
        <h3>Summary</h3>
        <ErrorBox error={summary.error} />
        {summary.data && (
          <>
            <div className="row-start">
              {DELIVERY_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="link small"
                  onClick={() => set({ status: s, errorClass: undefined })}
                >
                  <StatusFlag status={s} /> {summary.data.byStatus[s] ?? 0}
                </button>
              ))}
            </div>
            {summary.data.errors.length > 0 && (
              <div>
                <b className="small">Problems (failed or waiting to retry)</b>
                <ul className="list small">
                  {summary.data.errors.map((e) => (
                    <li key={e.errorClass ?? ''} className="row">
                      <span>{e.errorText ?? e.errorClass}</span>
                      <button
                        type="button"
                        className="link small"
                        onClick={() => set({ errorClass: e.errorClass ?? undefined, status: '' })}
                      >
                        {e.count} — show
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.data.destinations.length > 0 && (
              <details>
                <summary>Destinations ({summary.data.destinations.length})</summary>
                <table className="report">
                  <tbody>
                    {summary.data.destinations.map((d) => (
                      <tr key={d.id}>
                        <td>
                          {d.formName}: <b>{d.name}</b>{' '}
                          <span className="muted small">{DESTINATION_LABELS[d.kind]}</span>
                        </td>
                        <td>
                          <HealthText health={d} active={d.active} />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link small"
                            onClick={() => set({ destinationId: d.id })}
                          >
                            Show
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </>
        )}
      </section>

      <div className="card filters">
        <label>
          Status
          <select
            value={filters.status ?? ''}
            onChange={(e) => set({ status: e.target.value as DeliveryStatus | '' })}
            data-testid="deliveries-status"
          >
            <option value="">Any</option>
            {DELIVERY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Form
          <select value={filters.formId ?? ''} onChange={(e) => set({ formId: e.target.value })}>
            <option value="">All forms</option>
            {forms.data?.map((f) => (
              <option key={f.formId} value={f.formId}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination
          <select
            value={filters.destinationId ?? ''}
            onChange={(e) => set({ destinationId: e.target.value })}
          >
            <option value="">All</option>
            {destinations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        {filters.errorClass && (
          <button
            type="button"
            className="secondary"
            onClick={() => set({ errorClass: undefined })}
          >
            Clear problem filter
          </button>
        )}
      </div>

      <div className="card stack scroll">
        <div className="row-start">
          <button
            type="button"
            data-testid="deliveries-resend-selected"
            disabled={!selected.size}
            onClick={() => void resendSelected()}
          >
            Resend selected ({selected.size})
          </button>
          <button type="button" className="secondary" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {note && (
          <p className="ok small" role="status">
            {note}
          </p>
        )}
        <ErrorBox error={error ?? list.error} />
        <table className="report" data-testid="deliveries-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select every delivery that can be resent"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(resendable.map((r) => r.id)))
                  }
                />
              </th>
              <th>Updated</th>
              <th>Form / site</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Problem</th>
              <th>Attempts</th>
              <th>Next attempt</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <DeliveryLine
                  row={r}
                  selected={selected.has(r.id)}
                  onSelect={() => toggle(r.id)}
                  open={open === r.id}
                  onOpen={() => setOpen(open === r.id ? null : r.id)}
                  onResend={() => void resendOne(r.id)}
                  onRetry={() => void retryNow(r.id)}
                />
                {open === r.id && (
                  <tr>
                    <td colSpan={9}>
                      <DeliveryDetailView id={r.id} admin={admin} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {list.data && !rows.length && (
              <tr>
                <td colSpan={9} className="muted">
                  No deliveries match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {list.hasNextPage && (
          <button
            type="button"
            className="secondary"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </button>
        )}
      </div>
    </>
  );
}

function DeliveryLine({
  row: r,
  selected,
  onSelect,
  open,
  onOpen,
  onResend,
  onRetry,
}: {
  row: DeliveryRow;
  selected: boolean;
  onSelect(): void;
  open: boolean;
  onOpen(): void;
  onResend(): void;
  onRetry(): void;
}) {
  return (
    <tr className={selected ? 'selected' : undefined} data-testid="delivery-row">
      <td>
        {canResend(r.status) && (
          <input
            type="checkbox"
            aria-label={`Select ${r.destinationName} for ${r.formName}`}
            checked={selected}
            onChange={onSelect}
          />
        )}
      </td>
      <td className="nowrap">{when(r.updatedAt ?? r.createdAt)}</td>
      <td>
        <Link to={`/submissions/${r.submissionId}`}>{r.formName}</Link>
        <div className="muted small">{r.siteName ?? ''}</div>
      </td>
      <td>
        {r.destinationName}
        <div className="muted small">{DESTINATION_LABELS[r.kind]}</div>
      </td>
      <td>
        <StatusFlag status={r.status} />
        {r.generation > 1 && <span className="muted small"> resend {r.generation - 1}</span>}
      </td>
      <td className="small">{r.errorText ?? ''}</td>
      <td>{r.attemptCount}</td>
      <td className="nowrap small">{r.nextAttemptAt ? formatLocal(r.nextAttemptAt) : ''}</td>
      <td className="nowrap">
        <button type="button" className="link small" aria-expanded={open} onClick={onOpen}>
          {open ? 'Hide' : 'Details'}
        </button>{' '}
        {canRetryNow(r.status) && (
          <button
            type="button"
            className="secondary"
            data-testid="delivery-retry-now"
            onClick={onRetry}
          >
            Retry now
          </button>
        )}
        {canResend(r.status) && (
          <button
            type="button"
            className="secondary"
            data-testid="delivery-resend"
            onClick={onResend}
          >
            Resend
          </button>
        )}
      </td>
    </tr>
  );
}

function DeliveryDetailView({ id, admin }: { id: string; admin: boolean }) {
  const q = useQuery({
    queryKey: ['deliveries', 'detail', id],
    queryFn: () => deliveriesApi.get(id),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="muted small">Loading…</p>;
  const d = q.data;
  return (
    <div className="stack" data-testid="delivery-detail">
      {admin && d.lastError && (
        <p className="small">
          <b>Last error:</b> <span className="mono break">{d.lastError}</span>
        </p>
      )}
      {!d.attempts.length && <p className="muted small">No attempts yet.</p>}
      {d.attempts.map((a) => (
        <div key={`${a.generation}-${a.attemptNo}`} className="card stack">
          <div className="row">
            <b className="small">
              {a.generation > 1 ? `Resend ${a.generation - 1}, ` : ''}attempt {a.attemptNo}:{' '}
              {OUTCOME_LABELS[a.outcome] ?? a.outcome}
            </b>
            <span className="muted small">
              {when(a.finishedAt ?? a.startedAt)}
              {a.triggeredBy ? ` · by ${a.triggeredBy}` : ''}
            </span>
          </div>
          {admin && a.detail && <p className="small mono break">{a.detail}</p>}
          {admin && a.target && (
            <>
              <span className="muted small">Where it went</span>
              <Facts data={a.target} />
            </>
          )}
          {admin && a.evidence && (
            <>
              <span className="muted small">What the other system answered</span>
              <Facts data={a.evidence} />
            </>
          )}
          {admin && a.documents && a.documents.length > 0 && (
            <ul className="small">
              {a.documents.map((doc, i) => (
                <li key={i} className="mono break">
                  {doc.filename ?? doc.name ?? doc.format}
                  {doc.size ? ` (${Math.ceil(doc.size / 1024)} KB)` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** Phase 1 register summaries and Phase 2 task emails that gave up (admins). */
function SystemEmails() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system-emails'], queryFn: deliveriesApi.systemEmails });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const resend = async (kind: 'register' | 'task', subjectId: string) => {
    setError(null);
    setNote(null);
    try {
      await deliveriesApi.resendSystemEmail(kind, subjectId);
      setNote('Queued to send again.');
      await qc.invalidateQueries({ queryKey: ['system-emails'] });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card stack scroll">
      <h3>System emails that failed</h3>
      <p className="muted small">
        Register summaries and task emails that gave up after their retries.
      </p>
      {note && (
        <p className="ok small" role="status">
          {note}
        </p>
      )}
      <ErrorBox error={error ?? q.error} />
      <table className="report" data-testid="system-emails-table">
        <thead>
          <tr>
            <th>Last tried</th>
            <th>What</th>
            <th>Failures</th>
            <th>Problem</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((e) => (
            <tr key={`${e.kind}-${e.subjectId}`}>
              <td className="nowrap">{when(e.lastAt ?? e.createdAt)}</td>
              <td>
                {e.kind === 'register' ? 'Register' : 'Task'}: {e.title ?? e.subjectId}
              </td>
              <td>{e.failures ?? ''}</td>
              <td className="small mono break">{e.detail ?? ''}</td>
              <td>
                <button
                  type="button"
                  className="secondary"
                  data-testid="system-email-resend"
                  onClick={() => void resend(e.kind, e.subjectId)}
                >
                  Resend
                </button>
              </td>
            </tr>
          ))}
          {q.data && !q.data.length && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing failed.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

import { evaluateForm, formatLocal, type Answers, type Option } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FormRenderer } from '../components/form/FormRenderer';
import { api, type Bootstrap, type PublishedForm } from '../lib/api';
import { cacheGet } from '../offline/db';

const NO_LISTS: Record<string, Option[]> = {};

interface Targets {
  users: { id: string; display_name: string; role: string }[];
  groups: { id: string; name: string }[];
}
interface Org {
  sites: { id: string; name: string }[];
}

/** Send a form, optionally pre-filled, to a user's or a group's inbox. */
export function DispatchPage() {
  const { formId } = useParams();
  const qc = useQueryClient();
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => api<PublishedForm[]>('/forms') });
  const targets = useQuery({
    queryKey: ['dispatch-targets'],
    queryFn: () => api<Targets>('/dispatch-targets'),
  });
  const org = useQuery({ queryKey: ['org'], queryFn: () => api<Org>('/meta/org') });
  const form = forms.data?.find((f) => f.formId === formId);
  const lists =
    useLiveQuery(async () => (await cacheGet<Bootstrap>('bootstrap'))?.lists ?? {}, []) ?? NO_LISTS;

  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [siteId, setSiteId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [prefill, setPrefill] = useState<Answers>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const state = useMemo(
    () => (form ? evaluateForm(form.definition, prefill, { ignoreRequired: true, lists }) : null),
    [form, prefill, lists],
  );

  if (forms.isLoading) return <p className="muted">Loading…</p>;
  if (!form || !state) return <p className="card error">That form is not published.</p>;

  async function send() {
    setResult(null);
    const [kind, id] = assignee.split(':');
    try {
      await api('/dispatches', {
        method: 'POST',
        body: {
          formId,
          title: title || form!.name,
          instructions: instructions || undefined,
          siteId: siteId || null,
          ...(kind === 'user' ? { assignedUserId: id } : { assignedGroupId: id }),
          dueOn: dueOn || undefined,
          prefill,
        },
      });
      await qc.invalidateQueries({ queryKey: ['dispatches'] });
      setResult({ ok: true, text: 'Sent. It is now in their inbox.' });
      setPrefill({});
      setTitle('');
      setInstructions('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Send “{form.name}” as a task</h2>
        <label>
          Title
          <input
            value={title}
            placeholder={form.name}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          Instructions
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={2000}
          />
        </label>
        <div className="grid2">
          <label>
            Assign to
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              data-testid="assignee"
            >
              <option value="">Choose…</option>
              <optgroup label="Groups">
                {targets.data?.groups.map((g) => (
                  <option key={g.id} value={`group:${g.id}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="People">
                {targets.data?.users.map((u) => (
                  <option key={u.id} value={`user:${u.id}`}>
                    {u.display_name} ({u.role})
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Site{form.definition.settings.siteRequired ? ' *' : ''}
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              data-testid="dispatch-site"
            >
              <option value="">Choose…</option>
              {org.data?.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="card">
        <h3>Pre-fill answers (optional)</h3>
        <FormRenderer
          def={form.definition}
          answers={prefill}
          onChange={setPrefill}
          state={state}
          lists={lists}
          showAllErrors
          prefill
        />
      </div>
      <div className="card stack">
        {result && <p className={result.ok ? 'ok' : 'error'}>{result.text}</p>}
        <button
          disabled={!assignee || !state.valid}
          onClick={() => void send()}
          data-testid="send-task"
        >
          Send task
        </button>
        <Link to="/tasks">See all tasks</Link>
      </div>
    </div>
  );
}

interface DispatchRow {
  id: string;
  title: string;
  status: 'open' | 'completed' | 'cancelled';
  due_on: string | null;
  created_at: string;
  completed_at: string | null;
  completed_submission_id: string | null;
  site_name: string | null;
  form_name: string;
  assigned_user_name: string | null;
  assigned_group_name: string | null;
  created_by_name: string | null;
  completed_by_name: string | null;
}

export function TasksPage() {
  const [status, setStatus] = useState<'open' | 'completed' | 'cancelled' | ''>('open');
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['dispatches', status],
    queryFn: () => api<DispatchRow[]>(`/dispatches${status ? `?status=${status}` : ''}`),
  });
  return (
    <div className="stack">
      <div className="card row">
        <h2>Tasks sent</h2>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
      </div>
      <div className="card scroll">
        <table className="report" data-testid="tasks">
          <thead>
            <tr>
              <th>Task</th>
              <th>Assigned to</th>
              <th>Due</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.title}
                  <div className="small muted">
                    {d.form_name}
                    {d.site_name ? ` · ${d.site_name}` : ''} · sent {formatLocal(d.created_at)} by{' '}
                    {d.created_by_name}
                  </div>
                </td>
                <td>{d.assigned_user_name ?? `Group: ${d.assigned_group_name}`}</td>
                <td>{d.due_on ?? '—'}</td>
                <td>
                  {d.status}
                  {d.completed_by_name && (
                    <div className="small muted">by {d.completed_by_name}</div>
                  )}
                </td>
                <td className="nowrap">
                  {d.completed_submission_id && (
                    <Link to={`/submissions/${d.completed_submission_id}`}>Open</Link>
                  )}
                  {d.status === 'open' && (
                    <button
                      className="link"
                      onClick={async () => {
                        if (!confirm('Cancel this task?')) return;
                        await api(`/dispatches/${d.id}/cancel`, { method: 'POST' });
                        await qc.invalidateQueries({ queryKey: ['dispatches'] });
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

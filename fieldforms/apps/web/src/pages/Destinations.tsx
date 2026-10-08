import {
  DESTINATION_KINDS,
  DESTINATION_LABELS,
  FORMAT_LABELS,
  formatLocal,
  localDate,
  type DestinationInclude,
  type DestinationKind,
  type FormDefinition,
} from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorBox, HealthText, Warnings } from '../components/outputs/common';
import { DestinationSettingsEditor } from '../components/outputs/DestinationSettings';
import { ExpressionInput } from '../components/outputs/ExpressionInput';
import { IncludeEditor } from '../components/outputs/IncludeEditor';
import {
  carriesPersonalData,
  defaultInclude,
  defaultSettings,
  destinationBody,
  includableFields,
  kindFormats,
  needsConnection,
  settingsIssues,
  templateCanProduce,
  type DestinationDraft,
} from '../components/outputs/logic';
import { TestResult } from '../components/outputs/TestResult';
import {
  adminFormsApi,
  connectionsApi,
  destinationsApi,
  submissionsApi,
  templatesApi,
  type Backfilled,
  type DestinationRow,
} from '../lib/api';

/*
 * A form's destinations: where each submission is sent, in which formats, with what (POPIA).
 * Every save is checked by the server against each published version of the form; its
 * warnings are shown after saving. Checks and test sends run in the worker and are polled.
 */

export function DestinationsAdmin() {
  const { id: formId = '' } = useParams();
  const qc = useQueryClient();
  const key = ['admin', 'destinations', formId];
  const form = useQuery({
    queryKey: ['admin', 'form', formId],
    queryFn: () => adminFormsApi.get(formId),
  });
  const list = useQuery({ queryKey: key, queryFn: () => destinationsApi.list(formId) });
  const [editing, setEditing] = useState<DestinationRow | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const act = async (fn: () => Promise<string>) => {
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err);
    }
  };
  const def = form.data?.draft;

  if (editing)
    return (
      <DestinationEditor
        key={editing === 'new' ? 'new' : editing.id}
        formId={formId}
        def={def}
        existing={editing === 'new' ? null : editing}
        onClose={() => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: key });
        }}
      />
    );

  return (
    <section className="card stack scroll">
      <div className="row">
        <h3>Destinations: {form.data?.form.name ?? '…'}</h3>
        <span className="row-start">
          <Link to={`/admin/forms/${formId}`}>Back to the form</Link>
          <button type="button" data-testid="destination-new" onClick={() => setEditing('new')}>
            New destination
          </button>
        </span>
      </div>
      <p className="muted small">
        Each submission of this form is sent to every active destination whose condition it meets.
        Failed sends are retried; see Deliveries for the log.
      </p>
      {note && (
        <p className="ok small" role="status">
          {note}
        </p>
      )}
      <ErrorBox error={error ?? list.error ?? form.error} />
      <table className="report" data-testid="destinations-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Health</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.data
            ?.filter((d) => !d.archivedAt)
            .map((d) => (
              <tr key={d.id} data-testid="destination-row">
                <td>
                  <b>{d.name}</b>
                  <div className="muted small">
                    {d.formats.map((f) => FORMAT_LABELS[f]).join(', ')}
                    {d.condition && <> · only when {d.condition}</>}
                  </div>
                  {testing === d.id && (
                    <TestSend
                      formId={formId}
                      destinationId={d.id}
                      onClose={() => setTesting(null)}
                    />
                  )}
                </td>
                <td className="small">
                  {DESTINATION_LABELS[d.kind]}
                  {d.connectionName && <div className="muted">{d.connectionName}</div>}
                </td>
                <td>
                  <HealthText health={d.health} active={d.active} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${d.name} active`}
                    checked={d.active}
                    data-testid="destination-active"
                    onChange={(e) =>
                      void act(async () => {
                        const r = await destinationsApi.update(d.id, { active: e.target.checked });
                        return r.cancelled
                          ? `Turned off; ${r.cancelled} waiting deliveries cancelled.`
                          : e.target.checked
                            ? 'Turned on. Edit it to also send earlier submissions.'
                            : 'Turned off.';
                      })
                    }
                  />
                </td>
                <td className="nowrap">
                  <button type="button" className="secondary" onClick={() => setEditing(d)}>
                    Edit
                  </button>{' '}
                  <button
                    type="button"
                    className="secondary"
                    data-testid="destination-test"
                    onClick={() => setTesting(testing === d.id ? null : d.id)}
                  >
                    Check / test
                  </button>{' '}
                  {d.health.failingSince || (d.health.last24h?.failed ?? 0) > 0 ? (
                    <button
                      type="button"
                      className="secondary"
                      data-testid="destination-resend-failed"
                      onClick={() =>
                        void act(async () => {
                          const r = await destinationsApi.resendFailed(d.id);
                          return `${r.resent} failed deliveries queued again.`;
                        })
                      }
                    >
                      Resend failed
                    </button>
                  ) : null}{' '}
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      if (!confirm(`Archive "${d.name}"? Waiting deliveries are cancelled.`))
                        return;
                      void act(async () => {
                        const r = await destinationsApi.archive(d.id);
                        return `Archived; ${r.cancelled} waiting deliveries cancelled.`;
                      });
                    }}
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ))}
          {list.data && !list.data.some((d) => !d.archivedAt) && (
            <tr>
              <td colSpan={5} className="muted">
                This form sends nowhere yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** "Check" (settings and connection) and "Test send" (a sample, or a real submission). */
function TestSend({
  formId,
  destinationId,
  onClose,
}: {
  formId: string;
  destinationId: string;
  onClose(): void;
}) {
  const [testId, setTestId] = useState<{ id: string; title: string } | null>(null);
  const [submissionId, setSubmissionId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const today = localDate(new Date());
  const monthAgo = localDate(new Date(Date.now() - 30 * 86_400_000));
  const recent = useQuery({
    queryKey: ['admin', 'recent-submissions', formId],
    queryFn: () => submissionsApi.recent(formId, monthAgo, today),
  });
  const start = async (title: string, fn: () => Promise<{ testId: string }>) => {
    setError(null);
    setTestId(null);
    try {
      setTestId({ id: (await fn()).testId, title });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="card stack small" data-testid="destination-test-panel">
      <div className="row-start">
        <button
          type="button"
          className="secondary"
          data-testid="destination-check"
          onClick={() => void start('Check', () => destinationsApi.check(destinationId))}
        >
          Check
        </button>
        <label>
          Test with
          <select
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            data-testid="test-submission"
          >
            <option value="">A generated sample</option>
            {recent.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {formatLocal(s.server_received_at)} {s.site_name ?? ''} {s.submitted_by_name ?? ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="destination-test-send"
          onClick={() =>
            void start('Test send', () =>
              destinationsApi.testSend(destinationId, submissionId || undefined),
            )
          }
        >
          Test send
        </button>
        <button type="button" className="link small" onClick={onClose}>
          Close
        </button>
      </div>
      {submissionId && (
        <p className="warn-text">
          A real submission is personal information: it really goes to this destination, and sending
          it is recorded in the audit log.
        </p>
      )}
      <ErrorBox error={error} />
      {testId && <TestResult key={testId.id} testId={testId.id} title={testId.title} />}
    </div>
  );
}

function draftOf(d: DestinationRow | null): DestinationDraft {
  if (!d)
    return {
      name: '',
      kind: 'email',
      connectionId: '',
      formats: ['pdf'],
      templates: {},
      condition: '',
      settings: defaultSettings('email'),
      include: defaultInclude(),
      recipient: '',
      crossBorder: false,
      confirmCrossBorder: false,
      active: true,
      backfillSince: '',
    };
  return {
    name: d.name,
    kind: d.kind,
    connectionId: d.connectionId ?? '',
    formats: d.formats,
    templates: d.templates,
    condition: d.condition ?? '',
    settings: { ...defaultSettings(d.kind), ...d.settings },
    include: { ...defaultInclude(), ...d.include } as DestinationInclude,
    recipient: d.recipient ?? '',
    crossBorder: d.crossBorder,
    confirmCrossBorder: false,
    active: d.active,
    backfillSince: '',
  };
}

function DestinationEditor({
  formId,
  def,
  existing,
  onClose,
}: {
  formId: string;
  def: FormDefinition | undefined;
  existing: DestinationRow | null;
  onClose(): void;
}) {
  const [saved, setSaved] = useState<DestinationRow | null>(existing);
  const [d, setD] = useState<DestinationDraft>(() => draftOf(existing));
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{
    warnings: string[];
    backfilled?: Backfilled;
    cancelled?: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const connections = useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: () => connectionsApi.list(),
  });
  const templates = useQuery({
    queryKey: ['admin', 'templates', formId],
    queryFn: () => templatesApi.list(formId),
  });

  const set = (p: Partial<DestinationDraft>) => setD((x) => ({ ...x, ...p }));
  const connKind = needsConnection(d.kind);
  const { formats: allowed, required } = kindFormats(d.kind);
  const personal = d.crossBorder && carriesPersonalData(d.include);
  const issues = settingsIssues(d.kind, d.settings);
  const reactivating = !!saved && !saved.active && d.active;
  const showBackfill = (!saved || reactivating) && d.active;

  const changeKind = (kind: DestinationKind) =>
    set({
      kind,
      settings: defaultSettings(kind),
      connectionId: '',
      formats: kindFormats(kind).formats.length ? ['pdf'] : [],
      templates: {},
    });

  const save = async () => {
    setError(null);
    setResult(null);
    setSaving(true);
    try {
      const body = destinationBody(d);
      if (!saved) {
        const r = await destinationsApi.create(formId, body);
        setResult(r);
        setSaved(await destinationsApi.get(r.id));
      } else {
        const { kind: _kind, ...patch } = body;
        const r = await destinationsApi.update(saved.id, patch);
        setResult(r);
        setSaved(await destinationsApi.get(saved.id));
      }
      set({ backfillSince: '', confirmCrossBorder: false });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card stack" data-testid="destination-editor">
      <div className="row">
        <h3>{saved ? `Edit ${saved.name}` : 'New destination'}</h3>
        <button type="button" className="link" onClick={onClose}>
          Back to the list
        </button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid2">
          <label>
            Name
            <input
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
              required
              maxLength={120}
              data-testid="destination-name"
            />
          </label>
          <label>
            Kind
            <select
              value={d.kind}
              disabled={!!saved}
              onChange={(e) => changeKind(e.target.value as DestinationKind)}
              data-testid="destination-kind"
            >
              {DESTINATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DESTINATION_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {connKind ? (
            <label>
              Connection
              <select
                value={d.connectionId}
                onChange={(e) => set({ connectionId: e.target.value })}
                required
                data-testid="destination-connection"
              >
                <option value="">Choose…</option>
                {connections.data
                  ?.filter((c) => c.kind === connKind && (!c.archivedAt || c.id === d.connectionId))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <span className="small muted">
                Add one under <Link to="/admin/connections">Connections</Link>.
              </span>
            </label>
          ) : (
            <p className="small muted">Email goes through the server’s mail settings.</p>
          )}
        </div>

        {allowed.length > 0 && (
          <fieldset className="stack">
            <legend>Files{required ? ' (at least one)' : ''}</legend>
            {allowed.map((f) => {
              const on = d.formats.includes(f);
              const usable =
                templates.data?.filter((t) => !t.archivedAt && templateCanProduce(t.kind, f)) ?? [];
              return (
                <div key={f} className="row-start">
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={on}
                      data-testid={`format-${f}`}
                      onChange={(e) =>
                        set({
                          formats: e.target.checked
                            ? [...d.formats, f]
                            : d.formats.filter((x) => x !== f),
                        })
                      }
                    />{' '}
                    {FORMAT_LABELS[f]}
                  </label>
                  {on && usable.length > 0 && (
                    <select
                      aria-label={`Template for ${FORMAT_LABELS[f]}`}
                      value={d.templates[f] ?? ''}
                      onChange={(e) =>
                        set({ templates: { ...d.templates, [f]: e.target.value || undefined } })
                      }
                    >
                      <option value="">Built-in layout</option>
                      {usable.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        <ExpressionInput
          label="Only when (optional condition)"
          value={d.condition}
          onChange={(v) => set({ condition: v })}
          def={def}
          placeholder="e.g. score < 50"
          testid="destination-condition"
          help="Empty: every submission. Uses the form's field ids and the reserved names."
        />

        <fieldset className="stack">
          <legend>Settings</legend>
          <DestinationSettingsEditor
            kind={d.kind}
            value={d.settings}
            def={def}
            onChange={(settings) => set({ settings })}
          />
        </fieldset>

        <IncludeEditor
          value={d.include}
          fields={includableFields(def)}
          onChange={(include) => set({ include })}
        />

        <fieldset className="stack">
          <legend>Who receives it (POPIA record)</legend>
          <label>
            Recipient
            <input
              value={d.recipient}
              maxLength={200}
              placeholder="e.g. Head office HR, or Acme Payroll (Pty) Ltd"
              onChange={(e) => set({ recipient: e.target.value })}
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={d.crossBorder}
              onChange={(e) => set({ crossBorder: e.target.checked })}
              data-testid="destination-cross-border"
            />{' '}
            The data is stored outside South Africa (for example a cloud service abroad)
          </label>
          {personal && (
            <label className="inline warn-text">
              <input
                type="checkbox"
                checked={d.confirmCrossBorder}
                onChange={(e) => set({ confirmCrossBorder: e.target.checked })}
                data-testid="destination-confirm-cross-border"
              />{' '}
              I confirm that sending this personal information outside South Africa is allowed
              (POPIA section 72). This is recorded.
            </label>
          )}
        </fieldset>

        <div className="row-start">
          <label className="inline">
            <input
              type="checkbox"
              checked={d.active}
              onChange={(e) => set({ active: e.target.checked })}
            />{' '}
            Active
          </label>
          {showBackfill && (
            <label>
              Also send submissions since{' '}
              <input
                type="date"
                value={d.backfillSince}
                max={localDate(new Date())}
                onChange={(e) => set({ backfillSince: e.target.value })}
                data-testid="destination-backfill"
              />
            </label>
          )}
        </div>

        {issues.length > 0 && (
          <ul className="issues small">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} testid="destination-error" />
        {result && (
          <div className="stack" role="status" data-testid="destination-saved">
            <span className="ok small">
              Saved.
              {result.backfilled &&
                ` ${result.backfilled.created} earlier submissions queued (${result.backfilled.existing} already sent, ${result.backfilled.skipped} not matching).`}
              {result.cancelled ? ` ${result.cancelled} waiting deliveries cancelled.` : ''}
            </span>
            <Warnings items={result.warnings} testid="destination-warnings" />
          </div>
        )}
        <div className="row-start">
          <button type="submit" disabled={saving} data-testid="destination-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </form>
      {saved && <TestSend formId={formId} destinationId={saved.id} onClose={() => undefined} />}
    </section>
  );
}

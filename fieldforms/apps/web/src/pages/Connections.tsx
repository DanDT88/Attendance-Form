import {
  CONNECTION_KINDS,
  CONNECTION_LABELS,
  CONNECTION_SECRETS,
  formatLocal,
  type ConnectionKind,
} from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton, ErrorBox, ShownOnce } from '../components/outputs/common';
import {
  changedBindingFields,
  configChanged,
  configFromValues,
  configInputs,
  configIssues,
  configValues,
  daysUntil,
  reenterKeys,
  secretsPayload,
  secretsToReenter,
  type ConfigValues,
} from '../components/outputs/logic';
import { SecretField } from '../components/outputs/SecretField';
import { TestResult } from '../components/outputs/TestResult';
import { connectionsApi, type ConnectionRow } from '../lib/api';

/*
 * Connections: the credentials destinations share. Secrets are write-only (the API seals them
 * to the worker and only says whether each is set), and checks run in the worker, so this
 * screen starts a check and polls its result.
 */

const KEY = ['admin', 'connections'];

export function ConnectionsAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => connectionsApi.list() });
  const [editing, setEditing] = useState<ConnectionRow | 'new' | null>(null);
  const [check, setCheck] = useState<{ id: string; testId: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const runCheck = async (id: string) => {
    setError(null);
    try {
      setCheck({ id, testId: (await connectionsApi.check(id)).testId });
    } catch (err) {
      setError(err);
    }
  };
  const archive = async (c: ConnectionRow, archived: boolean) => {
    setError(null);
    try {
      await connectionsApi.update(c.id, { archived });
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (err) {
      setError(err);
    }
  };

  if (editing)
    return (
      <ConnectionEditor
        key={editing === 'new' ? 'new' : editing.id}
        existing={editing === 'new' ? null : editing}
        onClose={() => {
          setEditing(null);
          void qc.invalidateQueries({ queryKey: KEY });
        }}
      />
    );

  return (
    <section className="card stack scroll">
      <div className="row">
        <h3>Connections</h3>
        <button type="button" data-testid="connection-new" onClick={() => setEditing('new')}>
          New connection
        </button>
      </div>
      <p className="muted small">
        A connection holds the address and credentials for another system. Destinations on forms use
        it to send submissions there.
      </p>
      <ErrorBox error={error ?? q.error} />
      <table className="report" data-testid="connections-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Last check</th>
            <th>Used by</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((c) => {
            const days = daysUntil(c.secretExpiresOn);
            return (
              <tr key={c.id} className={c.archivedAt ? 'inactive' : undefined}>
                <td>
                  <b>{c.name}</b>
                  {c.archivedAt && <span className="flag info">Archived</span>}
                  {days !== null && days <= 30 && (
                    <div className="small warn-text">
                      {days < 0
                        ? `Credentials expired on ${c.secretExpiresOn}`
                        : `Credentials expire in ${days} day(s)`}
                    </div>
                  )}
                </td>
                <td className="small">{CONNECTION_LABELS[c.kind]}</td>
                <td className="small">
                  {c.lastCheck ? (
                    <>
                      <span className={`flag ${c.lastCheck.ok ? 'ok' : 'bad'}`}>
                        {c.lastCheck.ok ? 'OK' : 'Failed'}
                      </span>
                      {formatLocal(c.lastCheck.at)}
                      {c.lastCheck.detail && <div className="muted">{c.lastCheck.detail}</div>}
                    </>
                  ) : (
                    <span className="muted">Never checked</span>
                  )}
                  {check?.id === c.id && (
                    <TestResult key={check.testId} testId={check.testId} title="Check" />
                  )}
                </td>
                <td>{c.destinations} destination(s)</td>
                <td className="nowrap">
                  <button type="button" className="secondary" onClick={() => setEditing(c)}>
                    Edit
                  </button>{' '}
                  {!c.archivedAt && (
                    <button
                      type="button"
                      className="secondary"
                      data-testid="connection-check"
                      onClick={() => void runCheck(c.id)}
                    >
                      Check
                    </button>
                  )}{' '}
                  <button
                    type="button"
                    className="link small"
                    onClick={() => void archive(c, !c.archivedAt)}
                  >
                    {c.archivedAt ? 'Restore' : 'Archive'}
                  </button>
                </td>
              </tr>
            );
          })}
          {q.data && !q.data.length && (
            <tr>
              <td colSpan={5} className="muted">
                No connections yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function ConnectionEditor({
  existing,
  onClose,
}: {
  existing: ConnectionRow | null;
  onClose(): void;
}) {
  const [kind, setKind] = useState<ConnectionKind>(existing?.kind ?? 'webhook');
  const [name, setName] = useState(existing?.name ?? '');
  const [values, setValues] = useState<ConfigValues>(() => configValues(kind, existing?.config));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [expires, setExpires] = useState(existing?.secretExpiresOn ?? '');
  const [reenter, setReenter] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  const [secretsReset, setSecretsReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const detail = useQuery({
    queryKey: [...KEY, existing?.id],
    queryFn: () => connectionsApi.get(existing!.id),
    enabled: !!existing,
  });

  const inputs = configInputs(kind);
  const config = configFromValues(kind, values);
  const saved = detail.data ?? existing;
  const bindingChanged = saved ? changedBindingFields(kind, saved.config, config) : [];
  const payload = secretsPayload(kind, typed, cleared);
  const setKeys = saved && !bindingChanged.length ? saved.secretKeys : [];
  const mustReenter = new Set([...reenter, ...secretsToReenter(setKeys, payload)]);
  const issues = configIssues(kind, config);
  const editingConfig = !saved || configChanged(saved.config, config) || !!payload;

  const changeKind = (k: ConnectionKind) => {
    setKind(k);
    setValues(configValues(k));
    setTyped({});
    setCleared(new Set());
    setTestId(null);
  };

  const save = async () => {
    setError(null);
    setReenter([]);
    setSaving(true);
    try {
      if (!saved) {
        const r = await connectionsApi.create({
          name: name.trim(),
          kind,
          config,
          secrets: payload ?? {},
          secretExpiresOn: expires || null,
        });
        setTyped({});
        if (r.generated) setGenerated(r.generated.signingSecret);
        else onClose();
      } else {
        const r = await connectionsApi.update(saved.id, {
          name: name.trim(),
          ...(configChanged(saved.config, config) ? { config } : {}),
          ...(payload ? { secrets: payload } : {}),
          secretExpiresOn: expires || null,
        });
        setTyped({});
        setCleared(new Set());
        if (r.secretsReset) {
          setSecretsReset(true);
          await detail.refetch();
        } else onClose();
      }
    } catch (err) {
      setError(err);
      setReenter(reenterKeys((err as { details?: unknown }).details));
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setError(null);
    setTestId(null);
    try {
      const r =
        saved && !editingConfig
          ? await connectionsApi.check(saved.id)
          : await connectionsApi.checkDraft({ kind, config, secrets: payload ?? {} });
      setTestId(r.testId);
    } catch (err) {
      setError(err);
    }
  };

  if (generated)
    return (
      <ShownOnce
        title="Webhook signing secret"
        value={generated}
        testid="signing-secret"
        onDone={onClose}
      >
        <p className="small">
          The receiving system uses it to check that requests really come from FieldForms (the{' '}
          <code>x-fieldforms-signature</code> header).
        </p>
      </ShownOnce>
    );

  return (
    <section className="card stack" data-testid="connection-editor">
      <div className="row">
        <h3>{saved ? `Edit ${saved.name}` : 'New connection'}</h3>
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              data-testid="connection-name"
            />
          </label>
          <label>
            Kind
            <select
              value={kind}
              disabled={!!saved}
              onChange={(e) => changeKind(e.target.value as ConnectionKind)}
              data-testid="connection-kind"
            >
              {CONNECTION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CONNECTION_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {inputs.map((f) => (
          <div key={f.key} className="field">
            {f.type === 'boolean' ? (
              <label>
                <input
                  type="checkbox"
                  checked={values[f.key] === true}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                />{' '}
                {f.label}
              </label>
            ) : (
              <label>
                {f.label}
                {f.optional && <span className="muted small"> (optional)</span>}
                {f.type === 'enum' ? (
                  <select
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  >
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                    value={String(values[f.key] ?? '')}
                    spellCheck={false}
                    data-testid={`config-${f.key}`}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                )}
              </label>
            )}
            {f.help && <div className="help small muted">{f.help}</div>}
            {f.binding && saved && saved.secretKeys.length > 0 && (
              <div className="help small muted">Changing this clears the stored secrets.</div>
            )}
          </div>
        ))}
        {kind === 'webhook' && saved?.config.urlOrigin ? (
          <p className="small muted">
            Sends to <span className="mono">{String(saved.config.urlOrigin)}</span>
          </p>
        ) : null}

        {bindingChanged.length > 0 && saved && saved.secretKeys.length > 0 && (
          <div className="card warn small" role="alert" data-testid="binding-warning">
            You changed {bindingChanged.join(', ')}. Saving clears the stored secrets so they are
            never sent to a different server: enter them again below.
          </div>
        )}
        {secretsReset && (
          <div className="card warn small" role="status" data-testid="secrets-reset">
            Saved. The stored secrets were cleared because where they are sent changed. Enter them
            again and save.
          </div>
        )}

        <fieldset className="stack">
          <legend>Secrets</legend>
          <p className="muted small">
            Write-only: FieldForms never shows a stored secret. Leave a field empty to keep it.
            Secrets are saved together, so changing one means entering the others again.
          </p>
          {CONNECTION_SECRETS[kind].map((spec) => (
            <SecretField
              key={spec.key}
              spec={spec}
              isSet={setKeys.includes(spec.key)}
              value={typed[spec.key] ?? ''}
              cleared={cleared.has(spec.key)}
              mustReenter={mustReenter.has(spec.key)}
              onChange={(v) => setTyped({ ...typed, [spec.key]: v })}
              onClear={(c) => {
                const n = new Set(cleared);
                if (c) n.add(spec.key);
                else n.delete(spec.key);
                setCleared(n);
              }}
            />
          ))}
          <label>
            Credentials expire on <span className="muted small">(optional, for a reminder)</span>
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </fieldset>

        {issues.length > 0 && (
          <ul className="issues small">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} testid="connection-error" />
        <div className="row-start">
          <button type="submit" disabled={saving} data-testid="connection-save">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="secondary"
            data-testid="connection-check"
            onClick={() => void runCheck()}
          >
            Check connection
          </button>
          {saved && editingConfig && (
            <span className="muted small">
              Checks what is on this form (only the secrets typed here), without saving.
            </span>
          )}
        </div>
      </form>

      {testId && (
        <TestResult
          key={testId}
          testId={testId}
          title="Check"
          factAction={(k, v) => {
            if (k === 'hostKeySha256' && kind === 'sftp')
              return values.hostKeySha256 === v ? (
                <span className="flag ok">Pinned (save to keep it)</span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  data-testid="pin-fingerprint"
                  onClick={() => setValues({ ...values, hostKeySha256: v })}
                >
                  Pin this fingerprint
                </button>
              );
            if (k === 'serviceAccountEmail')
              return (
                <span className="small">
                  Share the Drive folders and sheets with this address. <CopyButton text={v} />
                </span>
              );
            return null;
          }}
        />
      )}

      {detail.data && detail.data.revisions.length > 0 && (
        <details className="small">
          <summary>History</summary>
          <ul>
            {detail.data.revisions.map((r) => (
              <li key={r.revision}>
                Revision {r.revision}, {formatLocal(r.createdAt)}
                {r.createdBy ? ` by ${r.createdBy}` : ''}
                {r.secretsReset && <span className="flag warn">secrets cleared</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

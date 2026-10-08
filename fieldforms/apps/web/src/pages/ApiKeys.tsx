import { API_SCOPE_KEYS, API_SCOPES, formatLocal, type ApiScope } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox, ShownOnce } from '../components/outputs/common';
import { endOfDaySast } from '../components/outputs/logic';
import {
  adminFormsApi,
  api,
  apiKeysApi,
  OPENAPI_URL,
  type ApiKeyBody,
  type ApiKeyRow,
  type SiteScopeType,
} from '../lib/api';

/*
 * API keys for the public REST API (/api/v1). A key is shown once when it is created; only its
 * prefix is kept to recognise it. Keys are limited by scope, by sites and optionally by form.
 */

const KEY = ['admin', 'api-keys'];

interface Named {
  id: string;
  name: string;
  deactivated_at?: string | null;
}

function useOrg() {
  const companies = useQuery({
    queryKey: ['admin', '/admin/companies'],
    queryFn: () => api<Named[]>('/admin/companies'),
  });
  const regions = useQuery({
    queryKey: ['admin', '/admin/regions'],
    queryFn: () => api<Named[]>('/admin/regions'),
  });
  const sites = useQuery({
    queryKey: ['admin', '/admin/sites'],
    queryFn: () => api<Named[]>('/admin/sites'),
  });
  return { company: companies.data ?? [], region: regions.data ?? [], site: sites.data ?? [] };
}

/** SAST date of an instant, for the expiry input. */
const sastDate = (iso: string | null) => (iso ? formatLocal(iso, 'yyyy-MM-dd') : '');

export function ApiKeysAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: apiKeysApi.list });
  const forms = useQuery({ queryKey: ['admin', 'forms-list'], queryFn: adminFormsApi.list });
  const [editing, setEditing] = useState<ApiKeyRow | 'new' | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const formName = (id: string) => forms.data?.find((f) => f.id === id)?.name ?? id.slice(0, 8);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const revoke = async (k: ApiKeyRow) => {
    if (!confirm(`Revoke "${k.name}"? Systems using it stop working at once.`)) return;
    setError(null);
    try {
      await apiKeysApi.revoke(k.id);
      await refresh();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="stack">
      {created && (
        <ShownOnce
          title="Your new API key"
          value={created}
          testid="api-key-created"
          onDone={() => setCreated(null)}
        >
          <p className="small">
            Send it as <code>Authorization: Bearer …</code>.
          </p>
        </ShownOnce>
      )}
      {editing && (
        <KeyForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          forms={forms.data ?? []}
          onDone={(key) => {
            setEditing(null);
            if (key) setCreated(key);
            void refresh();
          }}
        />
      )}
      <section className="card stack scroll">
        <div className="row">
          <h3>API keys</h3>
          <span className="row-start">
            <a href={OPENAPI_URL} target="_blank" rel="noreferrer">
              API description (OpenAPI)
            </a>
            <button type="button" data-testid="api-key-new" onClick={() => setEditing('new')}>
              New key
            </button>
          </span>
        </div>
        <ErrorBox error={error ?? q.error} />
        <table className="report" data-testid="api-keys-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Can</th>
              <th>Sites / forms</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((k) => (
              <tr key={k.id} className={k.revokedAt ? 'inactive' : undefined}>
                <td>
                  <b>{k.name}</b>
                  <div className="mono small muted">{k.prefix}…</div>
                  {k.revokedAt && (
                    <span className="flag bad">Revoked {formatLocal(k.revokedAt)}</span>
                  )}
                </td>
                <td className="small">{k.scopes.join(', ')}</td>
                <td className="small">
                  {k.allSites
                    ? 'All sites'
                    : k.siteScopes.map((s) => s.name ?? s.id.slice(0, 8)).join(', ') || 'No sites'}
                  <div className="muted">
                    {k.formIds?.length ? k.formIds.map(formName).join(', ') : 'All forms'}
                  </div>
                </td>
                <td className="small">
                  {formatLocal(k.createdAt)}
                  {k.createdBy ? ` by ${k.createdBy}` : ''}
                </td>
                <td className="small">{k.expiresAt ? formatLocal(k.expiresAt) : 'Never'}</td>
                <td className="small">{k.lastUsedAt ? formatLocal(k.lastUsedAt) : 'Never'}</td>
                <td className="nowrap">
                  {!k.revokedAt && (
                    <>
                      <button type="button" className="secondary" onClick={() => setEditing(k)}>
                        Edit
                      </button>{' '}
                      <button
                        type="button"
                        className="link small"
                        data-testid="api-key-revoke"
                        onClick={() => void revoke(k)}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {q.data && !q.data.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No API keys.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

const SCOPE_LABELS: Record<SiteScopeType, string> = {
  company: 'Companies',
  region: 'Regions',
  site: 'Sites',
};

function KeyForm({
  existing,
  forms,
  onDone,
}: {
  existing: ApiKeyRow | null;
  forms: { id: string; name: string; archived_at: string | null }[];
  onDone(createdKey?: string): void;
}) {
  const org = useOrg();
  const [name, setName] = useState(existing?.name ?? '');
  const [scopes, setScopes] = useState<ApiScope[]>(existing?.scopes ?? ['submissions:read']);
  const [allSites, setAllSites] = useState(existing?.allSites ?? false);
  const [siteScopes, setSiteScopes] = useState<{ type: SiteScopeType; id: string }[]>(
    existing?.siteScopes.map(({ type, id }) => ({ type, id })) ?? [],
  );
  const [formIds, setFormIds] = useState<string[]>(existing?.formIds ?? []);
  const [expires, setExpires] = useState(sastDate(existing?.expiresAt ?? null));
  const [error, setError] = useState<unknown>(null);

  const has = (type: SiteScopeType, id: string) =>
    siteScopes.some((s) => s.type === type && s.id === id);
  const toggleScope = (type: SiteScopeType, id: string, on: boolean) =>
    setSiteScopes(
      on
        ? [...siteScopes, { type, id }]
        : siteScopes.filter((s) => !(s.type === type && s.id === id)),
    );

  const save = async () => {
    setError(null);
    const body: ApiKeyBody = {
      name: name.trim(),
      scopes,
      allSites,
      siteScopes: allSites ? [] : siteScopes,
      formIds: formIds.length ? formIds : null,
      expiresAt: expires ? endOfDaySast(expires) : null,
    };
    try {
      if (existing) {
        await apiKeysApi.update(existing.id, body);
        onDone();
      } else onDone((await apiKeysApi.create(body)).key);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <form
      className="card stack"
      data-testid="api-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{existing ? `Edit ${existing.name}` : 'New API key'}</h3>
      <div className="grid2">
        <label>
          Name (who or what uses it)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            data-testid="api-key-name"
          />
        </label>
        <label>
          Expires at the end of <span className="muted small">(optional)</span>
          <input
            type="date"
            value={expires}
            min={sastDate(new Date().toISOString())}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
      </div>
      <fieldset>
        <legend>What it can read</legend>
        {API_SCOPE_KEYS.map((s) => (
          <label key={s} className="inline">
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              data-testid={`api-scope-${s}`}
              onChange={(e) =>
                setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))
              }
            />{' '}
            <span className="mono">{s}</span> <span className="muted small">{API_SCOPES[s]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="stack">
        <legend>Sites</legend>
        <label className="inline">
          <input
            type="checkbox"
            checked={allSites}
            onChange={(e) => setAllSites(e.target.checked)}
            data-testid="api-key-all-sites"
          />{' '}
          All sites (and submissions without a site)
        </label>
        {!allSites &&
          (['company', 'region', 'site'] as const).map((type) => (
            <details key={type} open={siteScopes.some((s) => s.type === type)}>
              <summary>
                {SCOPE_LABELS[type]} ({siteScopes.filter((s) => s.type === type).length})
              </summary>
              <div className="checks-grid">
                {org[type]
                  .filter((x) => !x.deactivated_at || has(type, x.id))
                  .map((x) => (
                    <label key={x.id} className="inline">
                      <input
                        type="checkbox"
                        checked={has(type, x.id)}
                        onChange={(e) => toggleScope(type, x.id, e.target.checked)}
                      />{' '}
                      {x.name}
                    </label>
                  ))}
              </div>
            </details>
          ))}
      </fieldset>
      <fieldset>
        <legend>Forms (none ticked: every form)</legend>
        <div className="checks-grid">
          {forms
            .filter((f) => !f.archived_at || formIds.includes(f.id))
            .map((f) => (
              <label key={f.id} className="inline">
                <input
                  type="checkbox"
                  checked={formIds.includes(f.id)}
                  onChange={(e) =>
                    setFormIds(
                      e.target.checked ? [...formIds, f.id] : formIds.filter((x) => x !== f.id),
                    )
                  }
                />{' '}
                {f.name}
              </label>
            ))}
        </div>
      </fieldset>
      <ErrorBox error={error} />
      <div className="row-start">
        <button type="submit" data-testid="api-key-save">
          {existing ? 'Save' : 'Create key'}
        </button>
        <button type="button" className="secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

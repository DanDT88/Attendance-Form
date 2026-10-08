import {
  evaluateForm,
  expr,
  FIELD_TYPES,
  formatLocal,
  formDefinition,
  validateDefinition,
  type Answers,
  type Field,
  type FieldType,
  type FormDefinition,
  type LeafField,
  type Option,
} from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FormRenderer } from '../components/form/FormRenderer';
import { api, ApiError } from '../lib/api';

interface FormRow {
  id: string;
  name: string;
  archived_at: string | null;
  draft_updated_at: string;
  latest_version: number | null;
  published_at: string | null;
  submissions: number;
}
interface ListRow {
  id: string;
  name: string;
  items: Option[];
  archived_at: string | null;
}

// ------------------------------------------------------------ list of forms

export function FormsAdmin() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const forms = useQuery({
    queryKey: ['admin', 'forms'],
    queryFn: () => api<FormRow[]>('/admin/forms'),
  });
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card stack">
      <h3>Forms</h3>
      {error && <p className="error">{error}</p>}
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const r = await api<{ id: string }>('/admin/forms', { method: 'POST', body: { name } });
            await qc.invalidateQueries({ queryKey: ['admin', 'forms'] });
            navigate(`/admin/forms/${r.id}`);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input
          placeholder="New form name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button>Create form</button>
      </form>
      <table className="report">
        <thead>
          <tr>
            <th>Form</th>
            <th>Published</th>
            <th>Submissions</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {forms.data?.map((f) => (
            <tr key={f.id} className={f.archived_at ? 'inactive' : ''}>
              <td>
                <Link to={`/admin/forms/${f.id}`}>{f.name}</Link>
                <div className="small muted">Draft saved {formatLocal(f.draft_updated_at)}</div>
              </td>
              <td>
                {f.latest_version ? (
                  `v${f.latest_version} · ${formatLocal(f.published_at!)}`
                ) : (
                  <span className="muted">not yet</span>
                )}
              </td>
              <td>{f.submissions}</td>
              <td>
                <button
                  className="link small"
                  onClick={async () => {
                    await api(`/admin/forms/${f.id}`, {
                      method: 'PATCH',
                      body: { archived: !f.archived_at },
                    });
                    await qc.invalidateQueries({ queryKey: ['admin', 'forms'] });
                  }}
                >
                  {f.archived_at ? 'Unarchive' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ------------------------------------------------------------ the editor

type Sel = { i: number; c?: number } | null;

function newField(type: FieldType, id: string): Field {
  const label = FIELD_TYPES.find((t) => t.type === type)!.label;
  switch (type) {
    case 'select':
    case 'multiselect':
      return {
        id,
        type,
        label,
        options: {
          source: 'inline',
          items: [
            { value: 'option_1', label: 'Option 1' },
            { value: 'option_2', label: 'Option 2' },
          ],
        },
      } as Field;
    case 'calculated':
      return { id, type, label, expression: '0' };
    case 'group':
      return { id, type, label, fields: [{ id: `${id}_item`, type: 'text', label: 'Item' }] };
    case 'note':
      return { id, type, label: 'Instructions', text: '' };
    default:
      return { id, type, label } as Field;
  }
}

function allIds(def: FormDefinition): Set<string> {
  const ids = new Set<string>();
  def.fields.forEach((f) => {
    ids.add(f.id);
    if (f.type === 'group') f.fields.forEach((c) => ids.add(c.id));
  });
  return ids;
}

function freeId(def: FormDefinition, base: string): string {
  const ids = allIds(def);
  for (let n = 1; ; n++) if (!ids.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function FormEditor() {
  const { id } = useParams();
  const qc = useQueryClient();
  const loaded = useQuery({
    queryKey: ['admin', 'form', id],
    queryFn: () =>
      api<{
        form: { id: string; name: string; archived_at: string | null };
        draft: FormDefinition;
        issues: { path: string; message: string }[];
        versions: {
          id: string;
          version: number;
          published_at: string;
          published_by: string | null;
        }[];
      }>(`/admin/forms/${id}`),
  });
  const lists = useQuery({
    queryKey: ['admin', 'lists'],
    queryFn: () => api<ListRow[]>('/admin/lists'),
  });
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [tab, setTab] = useState<'fields' | 'preview' | 'json'>('fields');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (loaded.data && !def) setDef(loaded.data.draft);
  }, [loaded.data, def]);

  const listIds = useMemo(
    () => new Set((lists.data ?? []).filter((l) => !l.archived_at).map((l) => l.id)),
    [lists.data],
  );
  const listItems = useMemo(
    () => Object.fromEntries((lists.data ?? []).map((l) => [l.id, l.items])),
    [lists.data],
  );
  const check = useMemo(() => (def ? validateDefinition(def, { listIds }) : null), [def, listIds]);

  if (loaded.isLoading || !def) return <p className="muted">Loading…</p>;
  if (loaded.error) return <p className="error">{(loaded.error as Error).message}</p>;

  const update = (next: FormDefinition) => {
    setDef(next);
    setDirty(true);
    setStatus(null);
  };
  const fieldAt = (s: Sel): Field | undefined => {
    if (!s) return undefined;
    const top = def.fields[s.i];
    if (s.c === undefined) return top;
    return top?.type === 'group' ? top.fields[s.c] : undefined;
  };
  const setFieldAt = (s: Sel, f: Field | null) => {
    if (!s) return;
    const fields = [...def.fields];
    if (s.c === undefined) {
      if (f) fields[s.i] = f;
      else fields.splice(s.i, 1);
    } else {
      const g = fields[s.i] as Extract<Field, { type: 'group' }>;
      const children = [...g.fields];
      if (f) children[s.c] = f as LeafField;
      else children.splice(s.c, 1);
      fields[s.i] = { ...g, fields: children };
    }
    update({ ...def, fields });
    if (!f) setSel(null);
  };
  const move = (s: Sel, dir: -1 | 1) => {
    if (!s) return;
    const fields = [...def.fields];
    if (s.c === undefined) {
      const j = s.i + dir;
      if (j < 0 || j >= fields.length) return;
      [fields[s.i], fields[j]] = [fields[j]!, fields[s.i]!];
      update({ ...def, fields });
      setSel({ i: j });
    } else {
      const g = fields[s.i] as Extract<Field, { type: 'group' }>;
      const children = [...g.fields];
      const j = s.c + dir;
      if (j < 0 || j >= children.length) return;
      [children[s.c], children[j]] = [children[j]!, children[s.c]!];
      fields[s.i] = { ...g, fields: children };
      update({ ...def, fields });
      setSel({ i: s.i, c: j });
    }
  };
  const add = (type: FieldType, intoGroup?: number) => {
    const fid = freeId(def, type === 'calculated' ? 'calc' : type);
    const f = newField(type, fid);
    if (intoGroup !== undefined) {
      const g = def.fields[intoGroup] as Extract<Field, { type: 'group' }>;
      const fields = [...def.fields];
      fields[intoGroup] = { ...g, fields: [...g.fields, f as LeafField] };
      update({ ...def, fields });
      setSel({ i: intoGroup, c: g.fields.length });
    } else {
      update({ ...def, fields: [...def.fields, f] });
      setSel({ i: def.fields.length });
    }
  };

  async function save(): Promise<boolean> {
    try {
      await api(`/admin/forms/${id}/draft`, { method: 'PUT', body: { definition: def } });
      setDirty(false);
      return true;
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
      return false;
    }
  }

  async function publish() {
    if (!(await save())) return;
    try {
      const r = await api<{ version: number }>(`/admin/forms/${id}/publish`, { method: 'POST' });
      setStatus({
        ok: true,
        text: `Published as version ${r.version}. Phones get it the next time they connect.`,
      });
      await qc.invalidateQueries({ queryKey: ['admin'] });
      await qc.invalidateQueries({ queryKey: ['forms'] });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof ApiError ? err.message : 'Publish failed' });
    }
  }

  const issues = check?.issues ?? [];
  const issueFor = (fieldId: string) => issues.filter((x) => x.path.split('.').includes(fieldId));
  const selected = fieldAt(sel);

  return (
    <div className="stack builder">
      <div className="card stack">
        <div className="row">
          <Link to="/admin/forms">← Forms</Link>
          <span className="row-start">
            <Link to={`/admin/forms/${id}/destinations`} data-testid="form-destinations">
              Destinations
            </Link>
          </span>
          <span className="small muted">
            {loaded.data!.versions.length
              ? `Latest: v${loaded.data!.versions[0]!.version}, ${formatLocal(loaded.data!.versions[0]!.published_at)}`
              : 'Never published'}
          </span>
        </div>
        <div className="grid2">
          <label>
            Title
            <input
              value={def.title}
              onChange={(e) => update({ ...def, title: e.target.value })}
              data-testid="form-title"
            />
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={def.settings.siteRequired}
              onChange={(e) =>
                update({ ...def, settings: { ...def.settings, siteRequired: e.target.checked } })
              }
            />
            Ask which site the form is about
          </label>
        </div>
        <label>
          Description
          <textarea
            rows={2}
            value={def.description ?? ''}
            onChange={(e) => update({ ...def, description: e.target.value || undefined })}
          />
        </label>
        <div className="actions row">
          <span className={issues.length ? 'error small' : 'ok small'} data-testid="issue-count">
            {issues.length
              ? `${issues.length} problem${issues.length > 1 ? 's' : ''} to fix before publishing`
              : 'Ready to publish'}
          </span>
          <span>
            <button
              className="secondary"
              disabled={!dirty}
              onClick={() =>
                void save().then((ok) => ok && setStatus({ ok: true, text: 'Draft saved.' }))
              }
            >
              Save draft
            </button>{' '}
            <button
              disabled={issues.length > 0}
              onClick={() => void publish()}
              data-testid="publish"
            >
              Publish
            </button>
          </span>
        </div>
        {status && <p className={status.ok ? 'ok' : 'error'}>{status.text}</p>}
        {issues.length > 0 && (
          <ul className="issues small">
            {issues.map((x, k) => (
              <li key={k}>
                <code>{x.path}</code>: {x.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <nav className="tabs">
        {(['fields', 'preview', 'json'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'fields' ? 'Fields' : t === 'preview' ? 'Preview' : 'JSON'}
          </button>
        ))}
      </nav>

      {tab === 'fields' && (
        <div className="builder-grid">
          <div className="card">
            <ol className="field-list">
              {def.fields.map((f, i) => (
                <li key={`${f.id}-${i}`}>
                  <FieldItem
                    f={f}
                    active={sel?.i === i && sel.c === undefined}
                    problems={issueFor(f.id).length}
                    onClick={() => setSel({ i })}
                  />
                  {f.type === 'group' && (
                    <ol className="field-list nested">
                      {f.fields.map((c, ci) => (
                        <li key={`${c.id}-${ci}`}>
                          <FieldItem
                            f={c}
                            active={sel?.i === i && sel.c === ci}
                            problems={issueFor(c.id).length}
                            onClick={() => setSel({ i, c: ci })}
                          />
                        </li>
                      ))}
                      <li>
                        <AddField onAdd={(t) => add(t, i)} inGroup />
                      </li>
                    </ol>
                  )}
                </li>
              ))}
            </ol>
            <AddField onAdd={(t) => add(t)} />
          </div>
          <div className="card stack">
            {selected ? (
              <FieldProperties
                key={`${sel!.i}-${sel!.c ?? ''}`}
                field={selected}
                lists={lists.data ?? []}
                problems={issueFor(selected.id)}
                onChange={(f) => setFieldAt(sel, f)}
                onRemove={() => setFieldAt(sel, null)}
                onMove={(d) => move(sel, d)}
              />
            ) : (
              <p className="muted">Choose a field to edit it, or add one.</p>
            )}
          </div>
        </div>
      )}
      {tab === 'preview' && <Preview def={def} lists={listItems} />}
      {tab === 'json' && <JsonEditor def={def} onApply={(d) => update(d)} />}
    </div>
  );
}

function FieldItem({
  f,
  active,
  problems,
  onClick,
}: {
  f: Field;
  active: boolean;
  problems: number;
  onClick(): void;
}) {
  return (
    <button
      className={`field-item${active ? ' active' : ''}`}
      onClick={onClick}
      data-testid={`field-${f.id}`}
    >
      <span>{f.label}</span>
      <span className="small muted">
        {FIELD_TYPES.find((t) => t.type === f.type)?.label} · {f.id}
        {'required' in f && f.required ? ' · required' : ''}
        {'visibleIf' in f && f.visibleIf ? ' · conditional' : ''}
      </span>
      {problems > 0 && <span className="flag bad">{problems}</span>}
    </button>
  );
}

function AddField({ onAdd, inGroup }: { onAdd(t: FieldType): void; inGroup?: boolean }) {
  return (
    <select
      value=""
      onChange={(e) => e.target.value && onAdd(e.target.value as FieldType)}
      data-testid={inGroup ? 'add-group-field' : 'add-field'}
      aria-label={inGroup ? 'Add a field to this group' : 'Add a field'}
    >
      <option value="">{inGroup ? '+ Add to group…' : '+ Add field…'}</option>
      {FIELD_TYPES.filter((t) => !inGroup || t.type !== 'group').map((t) => (
        <option key={t.type} value={t.type}>
          {t.label}
        </option>
      ))}
    </select>
  );
}

/** An expression box that says straight away whether the expression parses. */
function ExprInput({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  testid?: string;
}) {
  const c = value.trim() ? expr.check(value) : null;
  return (
    <label>
      {label}
      <input
        className="mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        spellCheck={false}
      />
      {c && !c.ok && (
        <span className="error small">
          {c.error} (at character {c.pos + 1})
        </span>
      )}
    </label>
  );
}

const num = (v: string): number | undefined => (v === '' ? undefined : Number(v));

function FieldProperties({
  field: f,
  lists,
  problems,
  onChange,
  onRemove,
  onMove,
}: {
  field: Field;
  lists: ListRow[];
  problems: { path: string; message: string }[];
  onChange(f: Field): void;
  onRemove(): void;
  onMove(dir: -1 | 1): void;
}) {
  const set = (patch: Record<string, unknown>) => {
    const next = { ...f, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as Field);
  };
  const requiredMode =
    !('required' in f) || !f.required ? 'no' : f.required === true ? 'yes' : 'when';

  return (
    <>
      <div className="row">
        <h3>{FIELD_TYPES.find((t) => t.type === f.type)?.label}</h3>
        <span className="nowrap">
          <button className="link" onClick={() => onMove(-1)} aria-label="Move up">
            ↑
          </button>
          <button className="link" onClick={() => onMove(1)} aria-label="Move down">
            ↓
          </button>
          <button className="link" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      {problems.map((p, k) => (
        <p key={k} className="error small">
          {p.message}
        </p>
      ))}
      <label>
        Question / label
        <input
          value={f.label}
          onChange={(e) => set({ label: e.target.value })}
          data-testid="prop-label"
        />
      </label>
      <label>
        Id (used in calculations)
        <input
          className="mono"
          value={f.id}
          onChange={(e) => set({ id: e.target.value.trim() })}
          data-testid="prop-id"
        />
      </label>
      {f.type === 'note' ? (
        <label>
          Text
          <textarea value={f.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
        </label>
      ) : (
        <label>
          Help text
          <input
            value={f.help ?? ''}
            onChange={(e) => set({ help: e.target.value || undefined })}
          />
        </label>
      )}

      {f.type !== 'note' && f.type !== 'calculated' && (
        <label>
          Required
          <select
            value={requiredMode}
            onChange={(e) =>
              set({
                required:
                  e.target.value === 'no' ? undefined : e.target.value === 'yes' ? true : 'TRUE',
              })
            }
            data-testid="prop-required"
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
            <option value="when">When…</option>
          </select>
        </label>
      )}
      {requiredMode === 'when' && 'required' in f && typeof f.required === 'string' && (
        <ExprInput
          label="Required when"
          value={f.required}
          onChange={(v) => set({ required: v })}
        />
      )}
      <ExprInput
        label="Show only when (leave empty to always show)"
        value={f.visibleIf ?? ''}
        onChange={(v) => set({ visibleIf: v.trim() ? v : undefined })}
        testid="prop-visible"
      />

      {f.type === 'text' && (
        <div className="grid2">
          <label className="inline">
            <input
              type="checkbox"
              checked={!!f.multiline}
              onChange={(e) => set({ multiline: e.target.checked || undefined })}
            />{' '}
            Several lines
          </label>
          <label>
            Keyboard
            <select
              value={f.keyboard ?? 'text'}
              onChange={(e) =>
                set({ keyboard: e.target.value === 'text' ? undefined : e.target.value })
              }
            >
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="tel">Phone</option>
              <option value="number">Digits</option>
            </select>
          </label>
          <label>
            Max length
            <input
              type="number"
              value={f.maxLength ?? ''}
              onChange={(e) => set({ maxLength: num(e.target.value) })}
            />
          </label>
        </div>
      )}
      {f.type === 'number' && (
        <div className="grid2">
          <label>
            Minimum
            <input
              type="number"
              value={f.min ?? ''}
              onChange={(e) => set({ min: num(e.target.value) })}
            />
          </label>
          <label>
            Maximum
            <input
              type="number"
              value={f.max ?? ''}
              onChange={(e) => set({ max: num(e.target.value) })}
            />
          </label>
          <label>
            Decimal places
            <input
              type="number"
              min={0}
              max={6}
              value={f.decimals ?? ''}
              onChange={(e) => set({ decimals: num(e.target.value) })}
            />
          </label>
          <label>
            Unit
            <input
              value={f.unit ?? ''}
              onChange={(e) => set({ unit: e.target.value || undefined })}
            />
          </label>
        </div>
      )}
      {(f.type === 'select' || f.type === 'multiselect') && (
        <OptionsEditor field={f} lists={lists} onChange={(patch) => set(patch)} />
      )}
      {f.type === 'calculated' && (
        <>
          <ExprInput
            label="Calculation"
            value={f.expression}
            onChange={(v) => set({ expression: v })}
            testid="prop-expression"
          />
          <p className="small muted">
            Use field ids, numbers, + − × ÷ and functions such as SUM(group.field), IF(cond, a, b),
            ROUND(x, 2), DATEDIFF(end, start, "days"). Functions: {expr.FUNCTION_NAMES.join(', ')}.
          </p>
          <label>
            Decimal places
            <input
              type="number"
              min={0}
              max={6}
              value={f.decimals ?? ''}
              onChange={(e) => set({ decimals: num(e.target.value) })}
            />
          </label>
        </>
      )}
      {f.type === 'image' && (
        <div className="grid2">
          <label className="inline">
            <input
              type="checkbox"
              checked={!!f.annotate}
              onChange={(e) => set({ annotate: e.target.checked || undefined })}
            />{' '}
            Allow markup (draw, arrows, text)
          </label>
          <label>
            Photos allowed
            <input
              type="number"
              min={1}
              max={10}
              value={f.maxCount ?? 1}
              onChange={(e) => set({ maxCount: num(e.target.value) })}
            />
          </label>
        </div>
      )}
      {f.type === 'group' && (
        <div className="grid2">
          <label>
            Minimum rows
            <input
              type="number"
              min={0}
              value={f.minRows ?? ''}
              onChange={(e) => set({ minRows: num(e.target.value) })}
            />
          </label>
          <label>
            Maximum rows
            <input
              type="number"
              min={1}
              value={f.maxRows ?? ''}
              onChange={(e) => set({ maxRows: num(e.target.value) })}
            />
          </label>
          <label>
            “Add row” button text
            <input
              value={f.addLabel ?? ''}
              onChange={(e) => set({ addLabel: e.target.value || undefined })}
            />
          </label>
        </div>
      )}
      {f.type !== 'note' && (
        <div className="stack">
          <b className="small">Checks</b>
          {(f.validations ?? []).map((v, k) => (
            <div key={k} className="grid2">
              <ExprInput
                label="Must be true"
                value={v.expr}
                onChange={(val) =>
                  set({
                    validations: (f.validations ?? []).map((x, j) =>
                      j === k ? { ...x, expr: val } : x,
                    ),
                  })
                }
              />
              <label>
                Message when not
                <input
                  value={v.message}
                  onChange={(e) =>
                    set({
                      validations: (f.validations ?? []).map((x, j) =>
                        j === k ? { ...x, message: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="link small"
                onClick={() =>
                  set({ validations: (f.validations ?? []).filter((_, j) => j !== k) })
                }
              >
                Remove check
              </button>
            </div>
          ))}
          <button
            className="secondary"
            onClick={() =>
              set({
                validations: [
                  ...(f.validations ?? []),
                  { expr: `${f.id} <> ""`, message: 'Please check this answer' },
                ],
              })
            }
          >
            Add a check
          </button>
        </div>
      )}
    </>
  );
}

function OptionsEditor({
  field: f,
  lists,
  onChange,
}: {
  field: Extract<Field, { type: 'select' | 'multiselect' }>;
  lists: ListRow[];
  onChange(patch: Record<string, unknown>): void;
}) {
  const inline = f.options.source === 'inline' ? f.options.items : [];
  const [text, setText] = useState(
    inline.map((o) => (o.value === o.label ? o.label : `${o.value},${o.label}`)).join('\n'),
  );
  return (
    <div className="stack">
      <label>
        Options from
        <select
          value={f.options.source}
          onChange={(e) =>
            onChange({
              options:
                e.target.value === 'list'
                  ? {
                      source: 'list',
                      listId: lists[0]?.id ?? '00000000-0000-0000-0000-000000000000',
                    }
                  : { source: 'inline', items: [{ value: 'option_1', label: 'Option 1' }] },
            })
          }
        >
          <option value="inline">Typed here</option>
          <option value="list">A managed list</option>
        </select>
      </label>
      {f.options.source === 'list' ? (
        <label>
          List
          <select
            value={f.options.listId}
            onChange={(e) => onChange({ options: { source: 'list', listId: e.target.value } })}
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.items.length})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          One option per line (“code,Label”, or just the label)
          <textarea
            rows={5}
            value={text}
            data-testid="prop-options"
            onChange={(e) => {
              setText(e.target.value);
              const items = e.target.value
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .map((l) => {
                  const [a, ...rest] = l.split(',');
                  const label = rest.join(',').trim();
                  const value = label
                    ? a!.trim()
                    : a!
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_|_$/g, '') || 'option';
                  return { value, label: label || a!.trim() };
                });
              if (items.length) onChange({ options: { source: 'inline', items } });
            }}
          />
        </label>
      )}
      {f.type === 'select' && (
        <label>
          Show as
          <select
            value={f.display ?? 'dropdown'}
            onChange={(e) =>
              onChange({ display: e.target.value === 'dropdown' ? undefined : e.target.value })
            }
          >
            <option value="dropdown">Drop-down list</option>
            <option value="buttons">Buttons</option>
          </select>
        </label>
      )}
      {f.type === 'multiselect' && (
        <div className="grid2">
          <label>
            Choose at least
            <input
              type="number"
              min={0}
              value={f.minSelected ?? ''}
              onChange={(e) => onChange({ minSelected: num(e.target.value) })}
            />
          </label>
          <label>
            Choose at most
            <input
              type="number"
              min={1}
              value={f.maxSelected ?? ''}
              onChange={(e) => onChange({ maxSelected: num(e.target.value) })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function Preview({ def, lists }: { def: FormDefinition; lists: Record<string, Option[]> }) {
  const [answers, setAnswers] = useState<Answers>({});
  const parsed = formDefinition.safeParse(def);
  if (!parsed.success)
    return <p className="card error">Fix the problems listed above to see a preview.</p>;
  const state = evaluateForm(parsed.data, answers, { lists });
  return (
    <div className="card stack" data-testid="preview">
      <p className="small muted">Try the form here. Nothing you enter is saved.</p>
      <FormRenderer
        def={parsed.data}
        answers={answers}
        onChange={setAnswers}
        state={state}
        lists={lists}
        showAllErrors={false}
      />
      <p className="small muted">
        {state.valid
          ? 'This would submit.'
          : `${state.errors.length} answer(s) still needed or invalid.`}
      </p>
    </div>
  );
}

function JsonEditor({ def, onApply }: { def: FormDefinition; onApply(d: FormDefinition): void }) {
  const [text, setText] = useState(JSON.stringify(def, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="card stack">
      <textarea
        className="mono json"
        rows={24}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {error && <p className="error">{error}</p>}
      <button
        onClick={() => {
          try {
            onApply(JSON.parse(text) as FormDefinition);
            setError(null);
          } catch (e) {
            setError(`Not valid JSON: ${(e as Error).message}`);
          }
        }}
      >
        Apply JSON
      </button>
    </div>
  );
}

// ------------------------------------------------------------ lists and groups

export function ListsAdmin() {
  const qc = useQueryClient();
  const lists = useQuery({
    queryKey: ['admin', 'lists'],
    queryFn: () => api<ListRow[]>('/admin/lists'),
  });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'lists'] });

  return (
    <section className="card stack">
      <h3>Option lists</h3>
      <p className="small muted">
        Choice fields can take their options from a list. Edit a list here, or load it from a CSV
        file of “value,label” rows.
      </p>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/admin/lists', { method: 'POST', body: { name } });
            setName('');
            await refresh();
          } catch (err) {
            setMsg({ ok: false, text: (err as Error).message });
          }
        }}
      >
        <input
          placeholder="New list name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button>Create list</button>
      </form>
      <table className="report">
        <tbody>
          {lists.data?.map((l) => (
            <tr key={l.id} className={l.archived_at ? 'inactive' : ''}>
              <td>
                <b>{l.name}</b>
                <div className="small muted">{l.items.length} items</div>
                {editing === l.id && (
                  <div className="stack">
                    <textarea
                      rows={8}
                      className="mono"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <span>
                      <button
                        onClick={async () => {
                          const items = text
                            .split('\n')
                            .map((x) => x.trim())
                            .filter(Boolean)
                            .map((x) => {
                              const [v, ...rest] = x.split(',');
                              return {
                                value: v!.trim(),
                                label: rest.join(',').trim() || v!.trim(),
                              };
                            });
                          try {
                            await api(`/admin/lists/${l.id}`, { method: 'PATCH', body: { items } });
                            setEditing(null);
                            setMsg({ ok: true, text: `Saved ${items.length} items.` });
                            await refresh();
                          } catch (err) {
                            setMsg({ ok: false, text: (err as Error).message });
                          }
                        }}
                      >
                        Save items
                      </button>{' '}
                      <button className="link" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
              </td>
              <td className="nowrap">
                <button
                  className="link small"
                  onClick={() => {
                    setEditing(l.id);
                    setText(l.items.map((o) => `${o.value},${o.label}`).join('\n'));
                  }}
                >
                  Edit items
                </button>{' '}
                <label className="link small">
                  Upload CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const res = await fetch(`/api/admin/lists/${l.id}/csv`, {
                        method: 'PUT',
                        credentials: 'same-origin',
                        headers: { 'x-fieldforms': '1', 'content-type': 'text/csv' },
                        body: await file.text(),
                      });
                      const body = (await res.json().catch(() => ({}))) as {
                        items?: number;
                        error?: string;
                      };
                      setMsg(
                        res.ok
                          ? { ok: true, text: `Loaded ${body.items} items.` }
                          : { ok: false, text: body.error ?? 'Upload failed' },
                      );
                      await refresh();
                    }}
                  />
                </label>{' '}
                <button
                  className="link small"
                  onClick={async () => {
                    await api(`/admin/lists/${l.id}`, {
                      method: 'PATCH',
                      body: { archived: !l.archived_at },
                    });
                    await refresh();
                  }}
                >
                  {l.archived_at ? 'Unarchive' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface GroupRow {
  id: string;
  name: string;
  archived_at: string | null;
  memberIds: string[];
}

export function GroupsAdmin() {
  const qc = useQueryClient();
  const groups = useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: () => api<GroupRow[]>('/admin/groups'),
  });
  const users = useQuery({
    queryKey: ['admin', '/admin/users'],
    queryFn: () =>
      api<{ id: string; display_name: string; role: string; active: boolean }[]>('/admin/users'),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
  const nameOf = (id: string) =>
    users.data?.find((u) => u.id === id)?.display_name ?? id.slice(0, 8);

  const save = async (id: string | null, body: Record<string, unknown>) => {
    setMsg(null);
    try {
      await api(id ? `/admin/groups/${id}` : '/admin/groups', {
        method: id ? 'PATCH' : 'POST',
        body,
      });
      await refresh();
      return true;
    } catch (err) {
      setMsg((err as Error).message);
      return false;
    }
  };

  return (
    <section className="card stack">
      <h3>Groups</h3>
      <p className="small muted">
        Send a form to a group and whoever submits first completes it for everyone.
      </p>
      {msg && <p className="error">{msg}</p>}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          if (await save(null, { name: f.get('name'), memberIds: f.getAll('members') }))
            form.reset();
        }}
      >
        <input name="name" placeholder="New group name" required />
        <label>
          Members (hold Ctrl/Cmd to choose several)
          <select name="members" multiple size={6}>
            {users.data
              ?.filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.role})
                </option>
              ))}
          </select>
        </label>
        <button>Create group</button>
      </form>
      <table className="report">
        <tbody>
          {groups.data?.map((g) => (
            <tr key={g.id} className={g.archived_at ? 'inactive' : ''}>
              <td>
                <b>{g.name}</b>
                <div className="small muted">
                  {g.memberIds.map(nameOf).join(', ') || 'No members'}
                </div>
              </td>
              <td className="nowrap">
                <select
                  multiple
                  size={4}
                  value={g.memberIds}
                  aria-label={`Members of ${g.name}`}
                  onChange={(e) =>
                    void save(g.id, {
                      memberIds: [...e.target.selectedOptions].map((o) => o.value),
                    })
                  }
                >
                  {users.data
                    ?.filter((u) => u.active)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name}
                      </option>
                    ))}
                </select>
                <button
                  className="link small"
                  onClick={() => void save(g.id, { archived: !g.archived_at })}
                >
                  {g.archived_at ? 'Unarchive' : 'Archive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

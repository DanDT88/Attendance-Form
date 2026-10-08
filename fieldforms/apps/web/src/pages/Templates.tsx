import {
  FORMAT_LABELS,
  formatLocal,
  localDate,
  TEMPLATE_FORMATS,
  TEMPLATE_KINDS,
  type Format,
  type TemplateKind,
} from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyButton, ErrorBox, Warnings } from '../components/outputs/common';
import { placeholderSnippet } from '../components/outputs/logic';
import {
  adminFormsApi,
  deliverFile,
  DOCX_TYPE,
  HTML_TYPE,
  submissionsApi,
  TEMPLATE_MAX_BYTES,
  templatesApi,
  type AdminFormRow,
  type TemplateDetail,
} from '../lib/api';

/*
 * Document templates: HTML (rendered to PDF) or Word (to Word or PDF). Every save is a new
 * version, checked by the server against the linked forms; its warnings are kept with it.
 */

const KIND_LABELS: Record<TemplateKind, string> = {
  html: 'HTML (for PDF)',
  docx: 'Word (for Word or PDF)',
};

/** Runs an action that returns a file and opens or saves it, reporting errors. */
function useFileAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => ReturnType<typeof templatesApi.starter>, mode: 'save' | 'open') => {
    setBusy(true);
    setError(null);
    try {
      deliverFile(await fn(), mode);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function TemplatesAdmin() {
  const [open, setOpen] = useState<string | null>(null);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'templates'], queryFn: () => templatesApi.list() });
  const forms = useQuery({ queryKey: ['admin', 'forms-list'], queryFn: adminFormsApi.list });
  const formName = (id: string) => forms.data?.find((f) => f.id === id)?.name ?? id.slice(0, 8);

  if (open)
    return (
      <TemplateEditor
        key={open}
        id={open}
        forms={forms.data ?? []}
        onClose={() => {
          setOpen(null);
          void qc.invalidateQueries({ queryKey: ['admin', 'templates'] });
        }}
      />
    );
  return (
    <div className="stack">
      <section className="card stack scroll">
        <h3>Document templates</h3>
        <ErrorBox error={list.error} />
        <table className="report" data-testid="templates-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Forms</th>
              <th>Latest version</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((t) => (
              <tr key={t.id} className={t.archivedAt ? 'inactive' : undefined}>
                <td>
                  <b>{t.name}</b>
                  {t.archivedAt && <span className="flag info">Archived</span>}
                </td>
                <td className="small">{KIND_LABELS[t.kind]}</td>
                <td className="small">{t.formIds.map(formName).join(', ') || '—'}</td>
                <td className="small">
                  {t.latest ? (
                    <>
                      v{t.latest.version}, {formatLocal(t.latest.createdAt)}
                      {t.latest.warnings.length > 0 && (
                        <span className="flag warn">{t.latest.warnings.length} warning(s)</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">No content yet</span>
                  )}
                </td>
                <td>
                  <button type="button" className="secondary" onClick={() => setOpen(t.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
            {list.data && !list.data.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No templates yet. Documents use the built-in layout.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <NewTemplate forms={forms.data ?? []} onCreated={setOpen} />
    </div>
  );
}

function FormChecks({
  forms,
  value,
  onChange,
}: {
  forms: AdminFormRow[];
  value: string[];
  onChange(v: string[]): void;
}) {
  return (
    <fieldset>
      <legend>Forms it is for</legend>
      <div className="checks-grid">
        {forms
          .filter((f) => !f.archived_at || value.includes(f.id))
          .map((f) => (
            <label key={f.id} className="inline">
              <input
                type="checkbox"
                checked={value.includes(f.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...value, f.id] : value.filter((x) => x !== f.id))
                }
              />{' '}
              {f.name}
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function NewTemplate({ forms, onCreated }: { forms: AdminFormRow[]; onCreated(id: string): void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TemplateKind>('html');
  const [formIds, setFormIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        templatesApi
          .create({ name: name.trim(), kind, formIds })
          .then((r) => onCreated(r.id))
          .catch(setError);
      }}
    >
      <h3>New template</h3>
      <div className="grid2">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            data-testid="template-name"
          />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FormChecks forms={forms} value={formIds} onChange={setFormIds} />
      <ErrorBox error={error} />
      <div>
        <button type="submit" data-testid="template-create">
          Create
        </button>
      </div>
    </form>
  );
}

function TemplateEditor({
  id,
  forms,
  onClose,
}: {
  id: string;
  forms: AdminFormRow[];
  onClose(): void;
}) {
  const q = useQuery({
    queryKey: ['admin', 'templates', 'detail', id],
    queryFn: () => templatesApi.get(id),
  });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const files = useFileAction();
  const t = q.data;

  const patch = async (body: Parameters<typeof templatesApi.update>[1], done: string) => {
    setError(null);
    setNote(null);
    try {
      await templatesApi.update(id, body);
      setNote(done);
      await q.refetch();
    } catch (err) {
      setError(err);
    }
  };
  const saveContent = async (body: Blob | string, type: string) => {
    setError(null);
    setNote(null);
    setWarnings([]);
    try {
      const r = await templatesApi.saveContent(id, body, type);
      setNote(`Saved as version ${r.version}.`);
      setWarnings(r.warnings);
      await q.refetch();
    } catch (err) {
      setError(err);
    }
  };

  if (q.error) return <ErrorBox error={q.error} />;
  if (!t) return <p className="muted">Loading…</p>;
  const latest = t.versions[0];
  return (
    <div className="stack" data-testid="template-editor">
      <section className="card stack">
        <div className="row">
          <h3>
            {t.name} <span className="muted small">{KIND_LABELS[t.kind]}</span>
          </h3>
          <button type="button" className="link" onClick={onClose}>
            Back to the list
          </button>
        </div>
        <TemplateMeta t={t} forms={forms} onSave={patch} />
        {note && (
          <p className="ok small" role="status">
            {note}
          </p>
        )}
        <Warnings items={warnings} testid="template-warnings" />
        <ErrorBox error={error ?? files.error} testid="template-error" />
      </section>

      <section className="card stack">
        <h3>Content</h3>
        {t.kind === 'html' ? (
          <HtmlContent
            id={id}
            version={latest?.version}
            onSave={(s) => saveContent(s, HTML_TYPE)}
          />
        ) : (
          <WordUpload onUpload={(f) => saveContent(f, DOCX_TYPE)} />
        )}
      </section>

      <Preview t={t} />

      <section className="card stack scroll">
        <h3>Versions</h3>
        <table className="report" data-testid="template-versions">
          <tbody>
            {t.versions.map((v) => (
              <tr key={v.id}>
                <td className="nowrap">v{v.version}</td>
                <td className="small">
                  {formatLocal(v.createdAt)}
                  {v.createdBy ? ` by ${v.createdBy}` : ''}
                </td>
                <td>
                  <Warnings items={v.warnings} />
                </td>
                <td>
                  <button
                    type="button"
                    className="link small"
                    disabled={files.busy}
                    onClick={() =>
                      void files.run(() => templatesApi.versionContent(id, v.version), 'save')
                    }
                  >
                    Download
                  </button>
                </td>
              </tr>
            ))}
            {!t.versions.length && (
              <tr>
                <td className="muted">No versions yet.</td>
              </tr>
            )}
          </tbody>
        </table>
        {t.usedBy.length > 0 && (
          <p className="small">
            Used by: {t.usedBy.map((d) => d.name).join(', ')} (it cannot be archived or unlinked
            from those forms while they use it).
          </p>
        )}
      </section>

      {t.formIds.length > 0 && <PlaceholderPanel kind={t.kind} formIds={t.formIds} forms={forms} />}
    </div>
  );
}

function TemplateMeta({
  t,
  forms,
  onSave,
}: {
  t: TemplateDetail;
  forms: AdminFormRow[];
  onSave(body: Parameters<typeof templatesApi.update>[1], done: string): Promise<void>;
}) {
  const [name, setName] = useState(t.name);
  const [formIds, setFormIds] = useState(t.formIds);
  return (
    <div className="stack">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <FormChecks forms={forms} value={formIds} onChange={setFormIds} />
      <div className="row-start">
        <button
          type="button"
          className="secondary"
          onClick={() => void onSave({ name: name.trim(), formIds }, 'Saved.')}
        >
          Save name and forms
        </button>
        <button
          type="button"
          className="link small"
          onClick={() =>
            void onSave({ archived: !t.archivedAt }, t.archivedAt ? 'Restored.' : 'Archived.')
          }
        >
          {t.archivedAt ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  );
}

/** The HTML source, loaded from the latest version; saving makes a new version. */
function HtmlContent({
  id,
  version,
  onSave,
}: {
  id: string;
  version: number | undefined;
  onSave(html: string): Promise<void>;
}) {
  const [html, setHtml] = useState<string | null>(version ? null : '');
  useEffect(() => {
    if (!version) return;
    let live = true;
    templatesApi
      .versionContent(id, version)
      .then((f) => f.blob.text())
      .then((s) => live && setHtml(s))
      .catch(() => live && setHtml(''));
    return () => {
      live = false;
    };
  }, [id, version]);
  if (html === null) return <p className="muted small">Loading…</p>;
  return (
    <div className="stack">
      <label>
        HTML (Liquid: <code>{'{{ field_id }}'}</code>, <code>{'{% for f in _fields %}'}</code>)
        <textarea
          className="code"
          value={html}
          spellCheck={false}
          onChange={(e) => setHtml(e.target.value)}
          data-testid="template-html"
        />
      </label>
      <div>
        <button type="button" data-testid="template-save" onClick={() => void onSave(html)}>
          Save as a new version
        </button>
      </div>
    </div>
  );
}

function WordUpload({ onUpload }: { onUpload(f: File): Promise<void> }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="stack">
      <p className="small muted">
        Upload a .docx with tags such as <code>{'{{field_id}}'}</code>, loops{' '}
        <code>{'{{#group}}…{{/group}}'}</code> and images <code>{'{{%photo_field}}'}</code>. Start
        from a form’s starter template below.
      </p>
      <input
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        data-testid="template-upload"
        aria-label="Word template file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          setProblem(null);
          if (!f) return;
          if (f.size > TEMPLATE_MAX_BYTES) return setProblem('The file is larger than 5 MB.');
          void onUpload(f);
        }}
      />
      {problem && <p className="error small">{problem}</p>}
    </div>
  );
}

function Preview({ t }: { t: TemplateDetail }) {
  const formats = TEMPLATE_FORMATS[t.kind];
  const [format, setFormat] = useState<Format>(formats[0]!);
  const [version, setVersion] = useState<number | ''>('');
  const [submissionId, setSubmissionId] = useState('');
  const files = useFileAction();
  const formId = t.formIds[0];
  const today = localDate(new Date());
  const recent = useQuery({
    queryKey: ['admin', 'recent-submissions', formId],
    queryFn: () =>
      submissionsApi.recent(formId!, localDate(new Date(Date.now() - 30 * 86_400_000)), today),
    enabled: !!formId,
  });
  if (!t.versions.length) return null;
  return (
    <section className="card stack">
      <h3>Preview</h3>
      <div className="row-start">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            {formats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Version
          <select
            value={version}
            onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Latest</option>
            {t.versions.map((v) => (
              <option key={v.id} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        {formId && (
          <label>
            With
            <select value={submissionId} onChange={(e) => setSubmissionId(e.target.value)}>
              <option value="">Sample answers</option>
              {recent.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {formatLocal(s.server_received_at)} {s.site_name ?? ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          data-testid="template-preview"
          disabled={files.busy}
          onClick={() =>
            void files.run(
              () =>
                templatesApi.preview(t.id, {
                  format,
                  ...(version ? { version } : {}),
                  ...(submissionId ? { submissionId } : {}),
                }),
              'open',
            )
          }
        >
          {files.busy ? 'Rendering…' : 'Preview'}
        </button>
      </div>
      {submissionId && (
        <p className="small warn-text">
          A real submission is personal data; the preview is audited.
        </p>
      )}
      <ErrorBox error={files.error} />
    </section>
  );
}

/** What a template can use for one of its forms, click to copy; and that form's starter file. */
function PlaceholderPanel({
  kind,
  formIds,
  forms,
}: {
  kind: TemplateKind;
  formIds: string[];
  forms: AdminFormRow[];
}) {
  const [formId, setFormId] = useState(formIds[0]!);
  const q = useQuery({
    queryKey: ['admin', 'placeholders', formId],
    queryFn: () => templatesApi.placeholders(formId),
  });
  const files = useFileAction();
  return (
    <section className="card stack scroll" data-testid="placeholders">
      <div className="row">
        <h3>Placeholders</h3>
        <span className="row-start">
          {formIds.length > 1 && (
            <select aria-label="Form" value={formId} onChange={(e) => setFormId(e.target.value)}>
              {formIds.map((f) => (
                <option key={f} value={f}>
                  {forms.find((x) => x.id === f)?.name ?? f}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="secondary"
            data-testid="starter-download"
            disabled={files.busy}
            onClick={() => void files.run(() => templatesApi.starter(formId, kind), 'save')}
          >
            Download a starter template
          </button>
        </span>
      </div>
      <ErrorBox error={q.error ?? files.error} />
      <table className="report">
        <tbody>
          {q.data?.map((p) => {
            const snippet = placeholderSnippet(kind, p);
            return (
              <tr key={p.name}>
                <td className="mono">{snippet ?? p.name}</td>
                <td>{p.label}</td>
                <td className="small muted">{p.sample}</td>
                <td>{snippet && <CopyButton text={snippet} className="link small" />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

const KEEP = '__keep';

/**
 * The templates a form's in-app downloads (PDF and Word) use. The API does not report the
 * current choice, so each select starts at "keep" and only changed ones are sent.
 */
export function FormDocuments() {
  const { id: formId = '' } = useParams();
  const form = useQuery({
    queryKey: ['admin', 'form', formId],
    queryFn: () => adminFormsApi.get(formId),
  });
  const templates = useQuery({
    queryKey: ['admin', 'templates', formId],
    queryFn: () => templatesApi.list(formId),
  });
  const [choice, setChoice] = useState<{ pdf: string; docx: string }>({ pdf: KEEP, docx: KEEP });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const files = useFileAction();
  const current = form.data?.form.document_templates ?? undefined;
  const save = async () => {
    setError(null);
    setNote(null);
    const body: { pdf?: string | null; docx?: string | null } = {};
    for (const f of ['pdf', 'docx'] as const) if (choice[f] !== KEEP) body[f] = choice[f] || null;
    try {
      await templatesApi.setDocumentTemplates(formId, body);
      setNote('Saved.');
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card stack" data-testid="form-documents">
      <div className="row">
        <h3>Documents: {form.data?.form.name ?? '…'}</h3>
        <Link to={`/admin/forms/${formId}`}>Back to the form</Link>
      </div>
      <p className="small muted">
        The layout of the PDF and Word downloads on a submission. Templates are made under{' '}
        <Link to="/admin/templates">Templates</Link> and must be linked to this form.
      </p>
      {(['pdf', 'docx'] as const).map((f) => (
        <label key={f}>
          {FORMAT_LABELS[f]}
          <select
            value={choice[f]}
            data-testid={`document-template-${f}`}
            onChange={(e) => setChoice({ ...choice, [f]: e.target.value })}
          >
            <option value={KEEP}>
              {current
                ? `Keep: ${templates.data?.find((t) => t.id === current[f])?.name ?? 'built-in layout'}`
                : 'Keep the current choice'}
            </option>
            <option value="">Built-in layout</option>
            {templates.data
              ?.filter((t) => !t.archivedAt && t.latest && TEMPLATE_FORMATS[t.kind].includes(f))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
      ))}
      {note && (
        <p className="ok small" role="status">
          {note}
        </p>
      )}
      <ErrorBox error={error ?? files.error} />
      <div className="row-start">
        <button type="button" data-testid="document-templates-save" onClick={() => void save()}>
          Save
        </button>
        {TEMPLATE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="secondary"
            disabled={files.busy}
            onClick={() => void files.run(() => templatesApi.starter(formId, k), 'save')}
          >
            Starter template ({k === 'html' ? 'HTML' : 'Word'})
          </button>
        ))}
      </div>
    </section>
  );
}

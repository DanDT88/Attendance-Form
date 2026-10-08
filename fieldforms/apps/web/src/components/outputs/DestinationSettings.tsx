import {
  RESERVED_VARIABLES,
  type DestinationKind,
  type FormDefinition,
  type MappingSource,
} from '@fieldforms/shared';
import type { ReactNode } from 'react';
import { VocabularyHint } from './common';
import { ExpressionInput } from './ExpressionInput';
import { emailFields, fileNameWarning, groupFields, mappableFields } from './logic';

/*
 * The per-kind settings of a destination, as `destinationSettingsSchemas` describes them. The
 * server validates them (and checks every name against each published version) on save.
 */

type Settings = Record<string, unknown>;

const NAMES: Record<string, string> = { ...RESERVED_VARIABLES };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const splitList = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Text({
  label,
  value,
  onChange,
  help,
  mono,
  testid,
  multiline,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  help?: ReactNode;
  mono?: boolean;
  testid?: string;
  multiline?: boolean;
}) {
  return (
    <label>
      {label}
      {multiline ? (
        <textarea
          value={value}
          rows={4}
          className={mono ? 'mono' : undefined}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testid}
        />
      ) : (
        <input
          value={value}
          className={mono ? 'mono' : undefined}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testid}
        />
      )}
      {help && <span className="small muted">{help}</span>}
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
  testid,
}: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  testid?: string;
}) {
  return (
    <label className="inline">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testid}
      />{' '}
      {label}
    </label>
  );
}

/** A file name template, with the vocabulary and the warning about unique names. */
function FileName({ s, set }: { s: Settings; set(p: Settings): void }) {
  const warning = fileNameWarning(str(s.filename));
  return (
    <div className="stack">
      <Text
        label="File name (without extension)"
        value={str(s.filename)}
        onChange={(v) => set({ filename: v })}
        mono
        testid="setting-filename"
      />
      {warning && (
        <span className="small warn-text" data-testid="filename-warning">
          {warning}
        </span>
      )}
      <VocabularyHint names={NAMES} />
    </div>
  );
}

function Folder({
  s,
  set,
  label = 'Folder',
}: {
  s: Settings;
  set(p: Settings): void;
  label?: string;
}) {
  return (
    <Text
      label={label}
      value={str(s.folder)}
      onChange={(v) => set({ folder: v })}
      mono
      help="Segments separated by /, each may use names such as {{ _site }} or {{ _received | date: '%Y-%m' }}."
      testid="setting-folder"
    />
  );
}

export function DestinationSettingsEditor({
  kind,
  value: s,
  def,
  onChange,
}: {
  kind: DestinationKind;
  value: Settings;
  def: FormDefinition | null | undefined;
  onChange(v: Settings): void;
}) {
  const set = (p: Settings) => onChange({ ...s, ...p });
  switch (kind) {
    case 'email':
      return <EmailSettings s={s} set={set} def={def} />;
    case 'webhook':
      return (
        <div className="stack">
          <Check
            label="Put the documents in the JSON body (base64)"
            checked={s.includeFiles === true}
            onChange={(v) => set({ includeFiles: v })}
          />
          <FileName s={s} set={set} />
        </div>
      );
    case 'sftp':
      return (
        <div className="stack">
          <Folder s={s} set={set} />
          <FileName s={s} set={set} />
        </div>
      );
    case 's3':
      return (
        <div className="stack">
          <Text
            label="Bucket"
            value={str(s.bucket)}
            onChange={(v) => set({ bucket: v })}
            mono
            testid="setting-bucket"
          />
          <Folder s={s} set={set} label="Folder (key prefix)" />
          <FileName s={s} set={set} />
        </div>
      );
    case 'google_drive':
      return (
        <div className="stack">
          <Text
            label="Shared Drive folder id"
            value={str(s.folderId)}
            onChange={(v) => set({ folderId: v })}
            mono
            help="The last part of the folder's URL. Service accounts can only store files on a Shared Drive; share the folder with the service account."
            testid="setting-folderId"
          />
          <Folder s={s} set={set} label="Sub-folder" />
          <FileName s={s} set={set} />
        </div>
      );
    case 'onedrive':
      return <OneDriveSettings s={s} set={set} />;
    case 'slack':
      return (
        <Text
          label="Message"
          value={str(s.message)}
          onChange={(v) => set({ message: v })}
          multiline
          mono
          help="Slack formatting and Liquid names, such as {{ _form }} and {{ _url }}. Keep personal details out of chat."
        />
      );
    case 'sql':
      return (
        <div className="stack">
          <div className="grid2">
            <Text
              label="Table (schema.table or table)"
              value={str(s.table)}
              onChange={(v) => set({ table: v })}
              mono
              testid="setting-table"
            />
            <Text
              label="Key column (needs a unique index)"
              value={str(s.keyColumn)}
              onChange={(v) => set({ keyColumn: v })}
              mono
              help="Holds the submission id (plus the row number with rows from a group), so a resend never adds a second row."
            />
            <label>
              When the row is already there
              <select
                value={str(s.mode) || 'insert'}
                onChange={(e) => set({ mode: e.target.value })}
              >
                <option value="insert">Leave it (insert only)</option>
                <option value="upsert">Update it (upsert)</option>
              </select>
            </label>
            <RowsFrom s={s} set={set} def={def} />
          </div>
          <MappingEditor nameKey="column" s={s} set={set} def={def} />
        </div>
      );
    case 'google_sheets':
      return (
        <div className="stack">
          <div className="grid2">
            <Text
              label="Spreadsheet id"
              value={str(s.spreadsheetId)}
              onChange={(v) => set({ spreadsheetId: v })}
              mono
              help="From the sheet's URL; share it with the service account as an editor."
              testid="setting-spreadsheetId"
            />
            <Text
              label="Sheet (tab) name"
              value={str(s.sheetName)}
              onChange={(v) => set({ sheetName: v })}
            />
            <RowsFrom s={s} set={set} def={def} />
            <Check
              label="Test sends append a row too"
              checked={s.testWrites === true}
              onChange={(v) => set({ testWrites: v })}
            />
          </div>
          <MappingEditor nameKey="header" s={s} set={set} def={def} />
        </div>
      );
  }
}

function EmailSettings({
  s,
  set,
  def,
}: {
  s: Settings;
  set(p: Settings): void;
  def: FormDefinition | null | undefined;
}) {
  const r = (s.recipients ?? {}) as Record<string, unknown>;
  const setR = (p: Record<string, unknown>) => set({ recipients: { ...r, ...p } });
  const fields = strList(r.fields);
  const replyTo = str(s.replyTo) || 'none';
  const custom = replyTo !== 'none' && replyTo !== 'submitter';
  return (
    <div className="stack">
      <fieldset className="stack">
        <legend>Recipients (at least one source)</legend>
        <Text
          label="Addresses"
          value={strList(r.addresses).join(', ')}
          onChange={(v) => setR({ addresses: splitList(v) })}
          testid="setting-addresses"
        />
        <div className="checks-grid">
          <Check
            label="The site's report recipients"
            checked={r.siteRecipients === true}
            onChange={(v) => setR({ siteRecipients: v })}
          />
          <Check
            label="Managers of the site"
            checked={r.siteManagers === true}
            onChange={(v) => setR({ siteManagers: v })}
          />
          <Check
            label="Whoever submitted it"
            checked={r.submitter === true}
            onChange={(v) => setR({ submitter: v })}
          />
          <Check
            label="Whoever sent the task"
            checked={r.taskSender === true}
            onChange={(v) => setR({ taskSender: v })}
          />
        </div>
        {emailFields(def).length > 0 && (
          <div>
            <span className="small muted">Addresses typed into the form:</span>
            <div className="checks-grid">
              {emailFields(def).map((f) => (
                <Check
                  key={f.id}
                  label={f.label}
                  checked={fields.includes(f.id)}
                  onChange={(v) =>
                    setR({ fields: v ? [...fields, f.id] : fields.filter((x) => x !== f.id) })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </fieldset>
      <div className="grid2">
        <Text
          label="Cc"
          value={strList(s.cc).join(', ')}
          onChange={(v) => set({ cc: splitList(v) })}
        />
        <label>
          Reply to
          <select
            value={custom ? 'custom' : replyTo}
            onChange={(e) => set({ replyTo: e.target.value === 'custom' ? '' : e.target.value })}
          >
            <option value="none">No reply-to</option>
            <option value="submitter">Whoever submitted it</option>
            <option value="custom">An address…</option>
          </select>
          {custom && (
            <input
              type="email"
              value={replyTo}
              aria-label="Reply-to address"
              onChange={(e) => set({ replyTo: e.target.value })}
            />
          )}
        </label>
      </div>
      <Text
        label="Subject"
        value={str(s.subject)}
        onChange={(v) => set({ subject: v })}
        mono
        testid="setting-subject"
      />
      <Text
        label="Message above the answers"
        value={str(s.message)}
        onChange={(v) => set({ message: v })}
        multiline
      />
      <Check
        label="Put the answers in the email body as well"
        checked={s.includeAnswers !== false}
        onChange={(v) => set({ includeAnswers: v })}
      />
      <FileName s={s} set={set} />
    </div>
  );
}

function OneDriveSettings({ s, set }: { s: Settings; set(p: Settings): void }) {
  const loc = (s.location ?? { type: 'site' }) as Record<string, string>;
  const setLoc = (p: Record<string, string>) => set({ location: { ...loc, ...p } });
  return (
    <div className="stack">
      <label>
        Where
        <select
          value={loc.type}
          onChange={(e) =>
            set({
              location:
                e.target.value === 'user'
                  ? { type: 'user', user: '' }
                  : { type: 'site', siteUrl: '', library: 'Documents' },
            })
          }
        >
          <option value="site">A SharePoint site's document library</option>
          <option value="user">A user's OneDrive</option>
        </select>
      </label>
      {loc.type === 'user' ? (
        <Text label="User (email)" value={str(loc.user)} onChange={(v) => setLoc({ user: v })} />
      ) : (
        <div className="grid2">
          <Text
            label="Site URL"
            value={str(loc.siteUrl)}
            onChange={(v) => setLoc({ siteUrl: v })}
            mono
          />
          <Text label="Library" value={str(loc.library)} onChange={(v) => setLoc({ library: v })} />
        </div>
      )}
      <Folder s={s} set={set} />
      <FileName s={s} set={set} />
    </div>
  );
}

function RowsFrom({
  s,
  set,
  def,
}: {
  s: Settings;
  set(p: Settings): void;
  def: FormDefinition | null | undefined;
}) {
  return (
    <label>
      Rows
      <select
        value={str(s.rowsFrom)}
        onChange={(e) => set({ rowsFrom: e.target.value || undefined })}
      >
        <option value="">One row per submission</option>
        {groupFields(def).map((g) => (
          <option key={g.id} value={g.id}>
            One row per row of “{g.label}”
          </option>
        ))}
      </select>
    </label>
  );
}

interface Column {
  column?: string;
  header?: string;
  source: MappingSource;
}

/** Column mapping for SQL and Sheets: each column takes a field's text or an expression. */
function MappingEditor({
  nameKey,
  s,
  set,
  def,
}: {
  nameKey: 'column' | 'header';
  s: Settings;
  set(p: Settings): void;
  def: FormDefinition | null | undefined;
}) {
  const columns = (Array.isArray(s.columns) ? s.columns : []) as Column[];
  const fields = mappableFields(def, str(s.rowsFrom) || undefined);
  const put = (i: number, c: Column) => set({ columns: columns.map((x, j) => (j === i ? c : x)) });
  const sqlName = (label: string) =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, '_$1')
      .slice(0, 63) || 'col';
  return (
    <fieldset className="stack" data-testid="mapping-editor">
      <legend>Columns</legend>
      <table className="report">
        <thead>
          <tr>
            <th>{nameKey === 'column' ? 'Column' : 'Header'}</th>
            <th>From</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={i}>
              <td>
                <input
                  className="mono"
                  aria-label="Column name"
                  value={c[nameKey] ?? ''}
                  onChange={(e) => put(i, { ...c, [nameKey]: e.target.value })}
                />
              </td>
              <td>
                <select
                  aria-label="Value from"
                  value={c.source.type}
                  onChange={(e) =>
                    put(i, {
                      ...c,
                      source:
                        e.target.value === 'field'
                          ? { type: 'field', field: fields[0]?.id ?? '' }
                          : { type: 'expression', expression: '' },
                    })
                  }
                >
                  <option value="field">A field</option>
                  <option value="expression">An expression</option>
                </select>
              </td>
              <td>
                {c.source.type === 'field' ? (
                  <select
                    aria-label="Field"
                    value={c.source.field}
                    onChange={(e) =>
                      put(i, { ...c, source: { type: 'field', field: e.target.value } })
                    }
                  >
                    <option value="">Choose…</option>
                    {fields.map((f) => (
                      <option key={`${f.group ?? ''}.${f.id}`} value={f.id}>
                        {f.groupLabel ? `${f.groupLabel} › ` : ''}
                        {f.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <ExpressionInput
                    label=""
                    value={c.source.expression}
                    def={def}
                    placeholder="e.g. _site or score * 2"
                    onChange={(v) =>
                      put(i, { ...c, source: { type: 'expression', expression: v } })
                    }
                  />
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="link small"
                  onClick={() => set({ columns: columns.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-start">
        <button
          type="button"
          className="secondary"
          data-testid="mapping-add"
          onClick={() =>
            set({
              columns: [
                ...columns,
                { [nameKey]: '', source: { type: 'field', field: fields[0]?.id ?? '' } },
              ],
            })
          }
        >
          Add a column
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            set({
              columns: [
                ...columns,
                ...fields
                  .filter((f) => f.type !== 'group')
                  .map((f) => ({
                    [nameKey]: nameKey === 'column' ? sqlName(f.id) : f.label,
                    source: { type: 'field' as const, field: f.id },
                  })),
              ],
            })
          }
        >
          Add every field
        </button>
      </div>
      <span className="small muted">
        A field gives its display text; an expression can use the reserved names (
        {Object.keys(RESERVED_VARIABLES).join(', ')}).
      </span>
    </fieldset>
  );
}

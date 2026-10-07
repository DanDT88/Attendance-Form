import {
  displayValue,
  type AnswerValue,
  type Answers,
  type Field,
  type FormDefinition,
  type FormState,
  type GeotagValue,
  type ImageValue,
  type LeafField,
  type Option,
} from '@fieldforms/shared';
import { useState } from 'react';
import { decodeBarcode } from '../../lib/barcode';
import { compressPhoto, readLocationOnce } from '../../lib/device';
import { useBlobUrl } from '../../lib/useBlobUrl';
import { localDb, putBlob } from '../../offline/db';
import { AnnotationEditor } from './AnnotationEditor';
import { SignaturePad } from './SignaturePad';

export interface RendererProps {
  def: FormDefinition;
  answers: Answers;
  onChange(next: Answers): void;
  state: FormState;
  lists: Record<string, Option[]>;
  /** Show every error, not just those of fields the user has touched (after pressing Submit). */
  showAllErrors: boolean;
  /** Pre-filling a task for someone else: no photos, signatures or locations. */
  prefill?: boolean;
}

/** Renders a form definition as inputs. Values flow out through onChange; nothing is kept here. */
export function FormRenderer(props: RendererProps) {
  const { def, answers, onChange } = props;
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (path: string) => setTouched((t) => (t.has(path) ? t : new Set(t).add(path)));

  return (
    <div className="form-fields">
      {def.fields.map((f) => (
        <FieldBlock
          key={f.id}
          field={f}
          path={f.id}
          value={answers[f.id]}
          computed={props.state.values[f.id]}
          set={(v) => {
            touch(f.id);
            onChange({ ...answers, [f.id]: v as AnswerValue });
          }}
          touched={touched}
          touch={touch}
          {...props}
        />
      ))}
    </div>
  );
}

interface BlockProps extends RendererProps {
  field: Field;
  path: string;
  value: AnswerValue | undefined;
  /** The value after calculation (for calculated fields and group rows). */
  computed: AnswerValue | undefined;
  set(v: AnswerValue | undefined): void;
  touched: Set<string>;
  touch(path: string): void;
}

function FieldBlock(p: BlockProps) {
  const { field: f, path, state } = p;
  const fs = state.fields[path];
  if (fs && !fs.visible) return null;
  const error = fs?.error && (p.showAllErrors || p.touched.has(path)) ? fs.error : null;

  if (f.type === 'note') {
    return (
      <div className="field note">
        <b>{f.label}</b>
        {f.text && <p className="muted">{f.text}</p>}
      </div>
    );
  }

  if (f.type === 'group') {
    const rows = (Array.isArray(p.value) ? p.value : []) as Answers[];
    const computedRows = (Array.isArray(p.computed) ? p.computed : []) as Answers[];
    return (
      <fieldset className="field group" data-field={path}>
        <legend>
          {f.label}
          {fs?.required && <span className="req"> *</span>}
        </legend>
        {f.help && <p className="help">{f.help}</p>}
        {rows.map((row, i) => (
          <div className="group-row" key={i} data-testid={`${path}-row-${i}`}>
            <div className="row">
              <b className="small">
                {f.label} {i + 1}
              </b>
              <button
                type="button"
                className="link small"
                onClick={() => p.set(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            {f.fields.map((c) => (
              <FieldBlock
                key={c.id}
                {...p}
                field={c}
                path={`${path}[${i}].${c.id}`}
                value={row[c.id]}
                computed={computedRows[i]?.[c.id]}
                set={(v) => {
                  p.touch(`${path}[${i}].${c.id}`);
                  p.set(rows.map((r, j) => (j === i ? { ...r, [c.id]: v as AnswerValue } : r)));
                }}
              />
            ))}
          </div>
        ))}
        {(f.maxRows === undefined || rows.length < f.maxRows) && (
          <button type="button" className="secondary" onClick={() => p.set([...rows, {}])}>
            {f.addLabel || 'Add row'}
          </button>
        )}
        {error && <p className="error small">{error}</p>}
      </fieldset>
    );
  }

  return (
    <div className={`field${error ? ' has-error' : ''}`} data-field={path}>
      <label className="field-label" htmlFor={path}>
        {f.label}
        {fs?.required && <span className="req"> *</span>}
      </label>
      {f.help && <p className="help">{f.help}</p>}
      <Input {...p} field={f} />
      {fs?.exprError && f.type === 'calculated' && (
        <p className="muted small">Cannot calculate: {fs.exprError}</p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Input(p: BlockProps & { field: LeafField }) {
  const { field: f, path, value, set } = p;
  const options = (): Option[] =>
    f.type === 'select' || f.type === 'multiselect'
      ? f.options.source === 'inline'
        ? f.options.items
        : (p.lists[f.options.listId] ?? [])
      : [];

  switch (f.type) {
    case 'text':
      return f.multiline ? (
        <textarea
          id={path}
          value={(value as string) ?? ''}
          maxLength={f.maxLength}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          id={path}
          type={f.keyboard === 'email' ? 'email' : f.keyboard === 'tel' ? 'tel' : 'text'}
          inputMode={f.keyboard === 'number' ? 'numeric' : undefined}
          value={(value as string) ?? ''}
          maxLength={f.maxLength}
          onChange={(e) => set(e.target.value)}
        />
      );
    case 'number':
      return (
        <div className="inline-input">
          <input
            id={path}
            type="number"
            inputMode={f.decimals === 0 ? 'numeric' : 'decimal'}
            step={f.decimals === undefined ? 'any' : f.decimals === 0 ? 1 : 1 / 10 ** f.decimals}
            min={f.min}
            max={f.max}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
          />
          {f.unit && <span className="muted">{f.unit}</span>}
        </div>
      );
    case 'select':
      return f.display === 'buttons' ? (
        <div className="seg" role="radiogroup" aria-label={f.label}>
          {options().map((o) => (
            <button
              type="button"
              key={o.value}
              role="radio"
              aria-checked={value === o.value}
              className={value === o.value ? 'on present' : ''}
              onClick={() => set(value === o.value ? null : o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <select
          id={path}
          value={(value as string) ?? ''}
          onChange={(e) => set(e.target.value || null)}
        >
          <option value="">Choose…</option>
          {options().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'multiselect': {
      const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <div className="checks" id={path}>
          {options().map((o) => (
            <label key={o.value} className="inline">
              <input
                type="checkbox"
                checked={chosen.has(o.value)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(o.value);
                  else next.delete(o.value);
                  set(
                    options()
                      .map((x) => x.value)
                      .filter((v) => next.has(v)),
                  );
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'date':
      return (
        <input
          id={path}
          type="date"
          value={(value as string) ?? ''}
          onChange={(e) => set(e.target.value || null)}
        />
      );
    case 'time':
      return (
        <input
          id={path}
          type="time"
          value={(value as string) ?? ''}
          onChange={(e) => set(e.target.value || null)}
        />
      );
    case 'datetime':
      return (
        <input
          id={path}
          type="datetime-local"
          value={(value as string) ?? ''}
          onChange={(e) => set(e.target.value || null)}
        />
      );
    case 'calculated':
      return (
        <output id={path} className="calc" data-testid={`calc-${path}`}>
          {displayValue(f, p.computed) || '—'}
        </output>
      );
    case 'geotag':
      return p.prefill ? (
        <p className="muted small">Captured when the form is filled in.</p>
      ) : (
        <GeotagInput {...p} />
      );
    case 'image':
      return p.prefill ? (
        <p className="muted small">Photos are taken when the form is filled in.</p>
      ) : (
        <ImageInput {...p} field={f} />
      );
    case 'signature':
      return p.prefill ? (
        <p className="muted small">Signed when the form is filled in.</p>
      ) : (
        <SignatureInput {...p} />
      );
    case 'barcode':
      return <BarcodeInput {...p} />;
    case 'note':
      return null;
  }
}

function GeotagInput({ value, set, path }: BlockProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const g = value as GeotagValue | null | undefined;
  return (
    <div className="inline-input" id={path}>
      {g ? (
        <span>
          {g.lat.toFixed(5)}, {g.lng.toFixed(5)}
          {g.accuracy ? ` (±${Math.round(g.accuracy)} m)` : ''}
        </span>
      ) : (
        <span className="muted">Not captured</span>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          // Read only now, because the user asked (POPIA: no background tracking).
          const fix = await readLocationOnce(15_000);
          setBusy(false);
          if (!fix)
            setMsg('Could not get a location. Check that location is allowed for this app.');
          else set({ ...fix, capturedAt: new Date().toISOString() });
        }}
      >
        {busy ? 'Locating…' : g ? 'Capture again' : 'Capture location'}
      </button>
      {g && (
        <button type="button" className="link" onClick={() => set(null)}>
          Clear
        </button>
      )}
      {msg && <span className="error small">{msg}</span>}
    </div>
  );
}

function Thumb({
  img,
  onAnnotate,
  onRemove,
  annotate,
}: {
  img: ImageValue;
  onAnnotate(): void;
  onRemove(): void;
  annotate: boolean;
}) {
  const photo = useBlobUrl(img.blobId);
  const layer = useBlobUrl(img.annotationBlobId);
  return (
    <div className="thumb">
      <div className="stack-img">
        {photo && <img src={photo} alt="Photo" />}
        {layer && <img src={layer} alt="" className="layer" />}
      </div>
      <div className="row small">
        {annotate && (
          <button type="button" className="link" onClick={onAnnotate}>
            {img.annotationBlobId ? 'Edit markup' : 'Mark up'}
          </button>
        )}
        <button type="button" className="link" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function ImageInput(p: BlockProps & { field: Extract<LeafField, { type: 'image' }> }) {
  const images = (Array.isArray(p.value) ? p.value : []) as ImageValue[];
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const max = p.field.maxCount ?? 1;
  const editingImg = editing !== null ? images[editing] : undefined;
  const photoUrl = useBlobUrl(editingImg?.blobId);
  const layerUrl = useBlobUrl(editingImg?.annotationBlobId);

  return (
    <div id={p.path}>
      <div className="thumbs">
        {images.map((img, i) => (
          <Thumb
            key={img.blobId}
            img={img}
            annotate={!!p.field.annotate}
            onAnnotate={() => setEditing(i)}
            onRemove={async () => {
              await localDb.blobs.bulkDelete([
                img.blobId,
                ...(img.annotationBlobId ? [img.annotationBlobId] : []),
              ]);
              p.set(images.filter((_, j) => j !== i));
            }}
          />
        ))}
      </div>
      {images.length < max && (
        <label className={`button secondary${busy ? ' disabled' : ''}`}>
          {busy ? 'Saving photo…' : images.length ? 'Add another photo' : 'Take photo'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            data-testid={`photo-${p.path}`}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              try {
                const data = await compressPhoto(file);
                const id = crypto.randomUUID();
                await putBlob({ id, data, contentType: 'image/jpeg' });
                p.set([...images, { blobId: id }]);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
      {editingImg && photoUrl && (
        <AnnotationEditor
          imageUrl={photoUrl}
          layerUrl={layerUrl}
          onCancel={() => setEditing(null)}
          onSave={async (png) => {
            const id = crypto.randomUUID();
            await putBlob({ id, data: png, contentType: 'image/png' });
            if (editingImg.annotationBlobId)
              await localDb.blobs.delete(editingImg.annotationBlobId);
            p.set(images.map((img, j) => (j === editing ? { ...img, annotationBlobId: id } : img)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SignatureInput({ value, set, path }: BlockProps) {
  const sig = value as { blobId: string } | null | undefined;
  const url = useBlobUrl(sig?.blobId);
  const [signing, setSigning] = useState(false);
  if (signing) {
    return (
      <SignaturePad
        onCancel={() => setSigning(false)}
        onSave={async (png) => {
          const id = crypto.randomUUID();
          await putBlob({ id, data: png, contentType: 'image/png' });
          if (sig) await localDb.blobs.delete(sig.blobId);
          set({ blobId: id });
          setSigning(false);
        }}
      />
    );
  }
  return (
    <div id={path} className="inline-input">
      {sig && url ? (
        <img className="signature-img" src={url} alt="Signature" />
      ) : (
        <span className="muted">Not signed</span>
      )}
      <button type="button" className="secondary" onClick={() => setSigning(true)}>
        {sig ? 'Sign again' : 'Sign'}
      </button>
    </div>
  );
}

function BarcodeInput({ value, set, path }: BlockProps) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="inline-input">
      <input
        id={path}
        value={(value as string) ?? ''}
        onChange={(e) => set(e.target.value || null)}
        placeholder="Scan or type the code"
      />
      <label className="button secondary">
        {busy ? 'Reading…' : 'Scan'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          data-testid={`scan-${path}`}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            setMsg(null);
            try {
              const code = await decodeBarcode(file);
              if (code) set(code);
              else setMsg('No code found in that photo. Try again closer, or type it.');
            } catch {
              setMsg('Could not read the code. Type it instead.');
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {msg && <span className="error small">{msg}</span>}
    </div>
  );
}

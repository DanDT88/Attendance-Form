import type { DestinationInclude } from '@fieldforms/shared';
import type { FieldOption } from './logic';

/**
 * What a destination may carry (POPIA). The document is filtered before it is rendered, so a
 * template or adapter cannot reach anything left out here. The defaults send every ordinary
 * answer and the marked-up photos, but no locations or original photos.
 */
export function IncludeEditor({
  value,
  fields,
  onChange,
}: {
  value: DestinationInclude;
  /** Top-level fields that are not photos, signatures or locations. */
  fields: FieldOption[];
  onChange(v: DestinationInclude): void;
}) {
  const set = (patch: Partial<DestinationInclude>) => onChange({ ...value, ...patch });
  const listed = value.fields === 'all' ? null : new Set(value.fields);
  return (
    <fieldset className="group" data-testid="include-editor">
      <legend>What this destination receives (POPIA)</legend>
      <p className="small muted">
        Send only what the recipient needs. By default: every answer except photos, signatures and
        locations; photos with their markup (not the originals); signatures; no location; and the
        name of the person who submitted it.
      </p>
      <label>
        Answers
        <select
          value={listed ? 'some' : 'all'}
          onChange={(e) =>
            set({ fields: e.target.value === 'all' ? 'all' : fields.map((f) => f.id) })
          }
          data-testid="include-fields"
        >
          <option value="all">Every answer (except photos, signatures and locations)</option>
          <option value="some">Only the answers ticked below</option>
        </select>
      </label>
      {listed && (
        <div className="checks-grid">
          {fields.map((f) => (
            <label key={f.id} className="inline">
              <input
                type="checkbox"
                checked={listed.has(f.id)}
                onChange={(e) => {
                  const next = new Set(listed);
                  if (e.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  set({ fields: fields.map((x) => x.id).filter((id) => next.has(id)) });
                }}
              />
              {f.label} <span className="muted small mono">{f.id}</span>
            </label>
          ))}
          {!fields.length && <span className="muted small">This form has no such answers.</span>}
        </div>
      )}
      <div className="grid2">
        <label>
          Photos
          <select
            value={value.photos}
            onChange={(e) => set({ photos: e.target.value as DestinationInclude['photos'] })}
            data-testid="include-photos"
          >
            <option value="none">None</option>
            <option value="marked_up">With their markup (default)</option>
            <option value="with_originals">With markup, plus the untouched originals</option>
          </select>
        </label>
        <label>
          Locations
          <select
            value={value.location}
            onChange={(e) => set({ location: e.target.value as DestinationInclude['location'] })}
            data-testid="include-location"
          >
            <option value="none">None (default)</option>
            <option value="rounded">Rounded to about 1 km</option>
            <option value="exact">Exact</option>
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={value.signatures}
            onChange={(e) => set({ signatures: e.target.checked })}
          />
          Signatures
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={value.submitter}
            onChange={(e) => set({ submitter: e.target.checked })}
            data-testid="include-submitter"
          />
          Who submitted it
        </label>
      </div>
    </fieldset>
  );
}

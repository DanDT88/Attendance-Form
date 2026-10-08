import { expr, RESERVED_VARIABLES, type FormDefinition } from '@fieldforms/shared';
import { unknownNames } from './logic';

/**
 * An expression box (a destination's condition, a column mapping) that says straight away
 * whether the expression parses, and which names the current draft does not have. The server
 * checks it against every published version when it is saved and answers with warnings.
 */
export function ExpressionInput({
  label,
  value,
  onChange,
  def,
  placeholder,
  testid,
  help,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  def: FormDefinition | null | undefined;
  placeholder?: string;
  testid?: string;
  help?: string;
}) {
  const src = value.trim();
  const syntax = src ? expr.check(src) : null;
  const unknown = syntax?.ok ? unknownNames(src, def) : [];
  return (
    <label>
      {label}
      <input
        className="mono"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        data-testid={testid}
      />
      {syntax && !syntax.ok && (
        <span className="error small">
          {syntax.error} (at character {syntax.pos + 1})
        </span>
      )}
      {unknown.length > 0 && (
        <span className="warn-text small">
          Not in the current draft: {unknown.join(', ')}. Saving checks every published version.
        </span>
      )}
      {help && <span className="small muted">{help}</span>}
    </label>
  );
}

/** The reserved names an expression can use, for help text. */
export const RESERVED_HINT = Object.keys(RESERVED_VARIABLES).join(', ');

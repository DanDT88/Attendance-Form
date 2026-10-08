import type { SecretField as SecretSpec } from '@fieldforms/shared';

/**
 * A write-only secret input. The server never sends a secret back, only whether it is set, so
 * the input always starts empty: leaving it empty keeps the stored value, typing replaces it and
 * "Clear" removes it. Nothing typed here is kept after the form is saved or closed.
 */
export function SecretField({
  spec,
  isSet,
  value,
  cleared,
  mustReenter,
  onChange,
  onClear,
}: {
  spec: SecretSpec;
  /** Whether the server has a value for this secret. */
  isSet: boolean;
  value: string;
  cleared: boolean;
  /** Stored, but must be typed again for this save (secrets are replaced together). */
  mustReenter?: boolean;
  onChange(v: string): void;
  onClear(clear: boolean): void;
}) {
  const id = `secret-${spec.key}`;
  const status = cleared ? 'will be cleared' : isSet ? 'set' : 'not set';
  const placeholder = cleared
    ? 'Will be cleared when you save'
    : isSet
      ? 'Leave empty to keep the stored value'
      : spec.optional
        ? 'Optional'
        : '';
  const common = {
    id,
    value,
    disabled: cleared,
    placeholder,
    spellCheck: false,
    autoComplete: 'off',
    'data-testid': `secret-${spec.key}`,
    'aria-describedby': `${id}-status`,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className={`secret-field${mustReenter ? ' reenter' : ''}`}>
      <label htmlFor={id}>
        <span>
          {spec.label}{' '}
          <span
            id={`${id}-status`}
            className={`flag ${cleared ? 'warn' : isSet ? 'ok' : 'info'}`}
            data-testid={`secret-${spec.key}-status`}
          >
            {status}
          </span>
          {mustReenter && <span className="flag warn">enter again</span>}
        </span>
      </label>
      {spec.multiline ? (
        <textarea {...common} rows={5} className="mono" />
      ) : (
        // new-password stops browsers filling in the admin's own saved password.
        <input {...common} type="password" autoComplete="new-password" />
      )}
      {isSet && (
        <button
          type="button"
          className="link small"
          onClick={() => {
            onChange('');
            onClear(!cleared);
          }}
          data-testid={`secret-${spec.key}-clear`}
        >
          {cleared ? 'Keep the stored value' : 'Clear'}
        </button>
      )}
    </div>
  );
}

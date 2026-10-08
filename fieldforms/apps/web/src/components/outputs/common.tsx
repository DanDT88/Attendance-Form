import { formatLocal, type DeliveryStatus } from '@fieldforms/shared';
import { useState, type ReactNode } from 'react';
import { ApiError, type DestinationHealth } from '../../lib/api';
import { detailLines, STATUS_FLAG, STATUS_LABELS } from './logic';

/** Small shared pieces of the Phase 3 screens. */

/** An error from the API with the server's details (validation issues, what to re-enter). */
export function ErrorBox({ error, testid }: { error: unknown; testid?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const lines = error instanceof ApiError ? detailLines(error.details) : [];
  return (
    <div className="error" role="alert" data-testid={testid}>
      {message}
      {lines.length > 0 && !(lines.length === 1 && lines[0] === message) && (
        <ul className="issues small">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Warnings({ items, testid }: { items: readonly string[]; testid?: string }) {
  if (!items.length) return null;
  return (
    <ul className="warnings small" data-testid={testid}>
      {items.map((w, i) => (
        <li key={i}>{w}</li>
      ))}
    </ul>
  );
}

export function StatusFlag({ status }: { status: DeliveryStatus }) {
  return (
    <span className={`flag ${STATUS_FLAG[status]}`} data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Copies text to the clipboard and says so. */
export function CopyButton({
  text,
  label = 'Copy',
  testid,
  className = 'secondary',
}: {
  text: string;
  label?: string;
  testid?: string;
  className?: string;
}) {
  const [done, setDone] = useState<'ok' | 'failed' | null>(null);
  return (
    <button
      type="button"
      className={className}
      data-testid={testid}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone('ok');
        } catch {
          setDone('failed');
        }
        setTimeout(() => setDone(null), 2000);
      }}
    >
      {done === 'ok' ? 'Copied' : done === 'failed' ? 'Select and copy it' : label}
    </button>
  );
}

/** Something shown only once (a new API key, a generated signing secret). */
export function ShownOnce({
  title,
  value,
  children,
  onDone,
  testid,
}: {
  title: string;
  value: string;
  children?: ReactNode;
  onDone(): void;
  testid?: string;
}) {
  return (
    <div className="card warn stack" data-testid={testid} role="status">
      <b>{title}</b>
      <p className="small">
        Copy it now and keep it somewhere safe. FieldForms stores only a fingerprint of it and
        cannot show it again.
      </p>
      <code className="once mono" data-testid={testid ? `${testid}-value` : undefined}>
        {value}
      </code>
      {children}
      <span className="row-start">
        <CopyButton text={value} testid={testid ? `${testid}-copy` : undefined} />
        <button type="button" onClick={onDone}>
          I have copied it
        </button>
      </span>
    </div>
  );
}

const when = (d: string | null | undefined) => (d ? formatLocal(d) : null);

/** A destination's health in a line: failing since, failures in a row, last success. */
export function HealthText({ health, active }: { health: DestinationHealth; active: boolean }) {
  const h = health;
  return (
    <span className="small">
      {!active ? (
        <span className="flag info">Inactive</span>
      ) : h.failingSince ? (
        <span className="flag bad">
          Failing since {when(h.failingSince)} ({h.consecutiveFailures} in a row)
        </span>
      ) : (
        <span className="flag ok">Healthy</span>
      )}
      <span className="muted">
        {' '}
        Last success: {when(h.lastSuccessAt) ?? 'never'}
        {h.last24h && (
          <>
            {' '}
            · 24 h: {h.last24h.delivered} delivered, {h.last24h.failed} failed, {h.last24h.pending}{' '}
            waiting
          </>
        )}
      </span>
    </span>
  );
}

/** Key/value pairs (a delivery's target or evidence, a check's facts). */
export function Facts({ data }: { data: Record<string, unknown> | null | undefined }) {
  const entries = Object.entries(data ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return null;
  return (
    <dl className="facts small">
      {entries.map(([k, v]) => (
        <FactRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function FactRow({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="mono break">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
    </>
  );
}

function Vocab({ name, text }: { name: string; text: string }) {
  return (
    <>
      <dt className="mono">{name}</dt>
      <dd>{text}</dd>
    </>
  );
}

/** The names a template, condition or file name can use, for a hint under the input. */
export function VocabularyHint({ names }: { names: Record<string, string> }) {
  return (
    <details className="small muted">
      <summary>Names you can use</summary>
      <p>
        Field ids as they are (in templates <code>{'{{ area }}'}</code> gives the display text), and
        these:
      </p>
      <dl className="facts">
        {Object.entries(names).map(([k, v]) => (
          <Vocab key={k} name={k} text={v} />
        ))}
      </dl>
    </details>
  );
}

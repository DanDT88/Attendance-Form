import { formatLocal } from '@fieldforms/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { testsApi, type TestRun } from '../../lib/api';
import { ErrorBox, Facts, Warnings } from './common';

/** Checks and test sends run in the worker (only it can open secrets); the screen polls. */
const POLL_MS = 1500;
/** After this long a queued check probably means no worker is running. */
const SLOW_MS = 60_000;

const done = (t: TestRun | undefined) => t?.status === 'ok' || t?.status === 'failed';

export function useTestRun(testId: string | null, onDone?: (t: TestRun) => void) {
  const [started] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ['admin-test', testId],
    queryFn: () => testsApi.get(testId!),
    enabled: !!testId,
    refetchInterval: (query) => (done(query.state.data) ? false : POLL_MS),
    refetchIntervalInBackground: false,
  });
  const finished = done(q.data);
  // The latest callback, reported once when the run finishes (polling stops then).
  const report = useRef(onDone);
  useEffect(() => {
    report.current = onDone;
  });
  useEffect(() => {
    if (finished && q.data) report.current?.(q.data);
  }, [finished, q.data]);
  return { run: q.data, error: q.error, slow: !finished && Date.now() - started > SLOW_MS };
}

/**
 * The result of a check or test send: its summary, facts (with optional actions, such as
 * pinning an SFTP host key), warnings, and where it went.
 */
export function TestResult({
  testId,
  title = 'Check',
  factAction,
  onDone,
}: {
  testId: string;
  title?: string;
  /** Extra controls next to a fact (key, value). */
  factAction?: (key: string, value: string) => ReactNode;
  onDone?: (t: TestRun) => void;
}) {
  const { run, error, slow } = useTestRun(testId, onDone);
  if (error) return <ErrorBox error={error} />;
  const status = run?.status ?? 'queued';
  const r = run?.result;
  return (
    <div className={`test-result ${status}`} data-testid="test-result" data-status={status}>
      <b>{title}: </b>
      {status === 'queued' && <span className="muted">waiting for the worker…</span>}
      {status === 'running' && <span className="muted">running…</span>}
      {status === 'ok' && <span className="ok">{r?.summary ?? 'OK'}</span>}
      {status === 'failed' && <span className="error">{r?.summary ?? 'Failed'}</span>}
      {slow && (
        <p className="small warn-text">
          This is taking a while. Checks run in the background worker: make sure it is running.
        </p>
      )}
      {r?.facts && Object.keys(r.facts).length > 0 && (
        <dl className="facts small">
          {Object.entries(r.facts).map(([k, v]) => (
            <FactLine key={k} k={k} v={v} action={factAction?.(k, v)} />
          ))}
        </dl>
      )}
      <Warnings items={r?.warnings ?? []} testid="test-warnings" />
      {(r?.target || r?.evidence) && (
        <details className="small">
          <summary>Where it went</summary>
          <Facts data={r?.target} />
          <Facts data={r?.evidence} />
        </details>
      )}
      {run?.finishedAt && (
        <span className="small muted"> {formatLocal(run.finishedAt, 'yyyy-MM-dd HH:mm:ss')}</span>
      )}
    </div>
  );
}

const FACT_LABELS: Record<string, string> = {
  hostKeySha256: 'Host key (SHA256)',
  serviceAccountEmail: 'Service account',
  actingAs: 'Acting as',
  loginFolder: 'Login folder',
};

function FactLine({ k, v, action }: { k: string; v: string; action?: ReactNode }) {
  return (
    <>
      <dt>{FACT_LABELS[k] ?? k}</dt>
      <dd>
        <span className="mono break" data-testid={`fact-${k}`}>
          {v}
        </span>
        {action && <div>{action}</div>}
      </dd>
    </>
  );
}

import { DESTINATION_LABELS, FORMATS, formatLocal, type Format } from '@fieldforms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { deliverFile, deliveriesApi, documentsApi } from '../../lib/api';
import { ErrorBox, StatusFlag } from './common';
import { canResend } from './logic';

/** Button labels: short, since six sit in a row on a phone. */
const DOWNLOAD_LABELS: Record<Format, string> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  json: 'JSON',
  xml: 'XML',
  images: 'Photos ZIP',
};

/**
 * A submission as a file, rendered by the server with the form's default template. Every
 * download is audited as a view; PDFs open in a tab, everything else is saved.
 */
export function DocumentDownloads({ submissionId }: { submissionId: string }) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<unknown>(null);
  const download = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      deliverFile(await documentsApi.download(submissionId, format), 'open');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="row-start" role="group" aria-label="Download this submission">
        {FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            className="secondary"
            data-testid={`download-${f}`}
            disabled={busy !== null}
            onClick={() => void download(f)}
          >
            {busy === f ? 'Preparing…' : DOWNLOAD_LABELS[f]}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

/** Where this submission was sent, with a resend for finished deliveries (office only). */
export function SubmissionDeliveries({ submissionId }: { submissionId: string }) {
  const qc = useQueryClient();
  const key = ['submission-deliveries', submissionId];
  const q = useQuery({ queryKey: key, queryFn: () => deliveriesApi.forSubmission(submissionId) });
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const resend = async (id: string) => {
    setError(null);
    setNote(null);
    try {
      const r = await deliveriesApi.resend(id);
      setNote(r.resent ? 'Queued to send again.' : `Not resent: ${r.reason ?? 'not possible now'}`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err);
    }
  };
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="muted small">Loading deliveries…</p>;
  if (!q.data.length) return <p className="muted small">This form sends nowhere.</p>;
  return (
    <div className="stack">
      <table className="report" data-testid="submission-deliveries">
        <thead>
          <tr>
            <th>Destination</th>
            <th>Status</th>
            <th>Delivered</th>
            <th>Problem</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((d) => (
            <tr key={d.id} data-testid="submission-delivery">
              <td>
                {d.destinationName}{' '}
                <span className="muted small">{DESTINATION_LABELS[d.kind] ?? d.kind}</span>
              </td>
              <td>
                <StatusFlag status={d.status} />
                {d.attemptCount ? (
                  <span className="muted small"> {d.attemptCount} attempt(s)</span>
                ) : null}
              </td>
              <td className="nowrap">{d.deliveredAt ? formatLocal(d.deliveredAt) : '—'}</td>
              <td className="small">{d.errorText ?? ''}</td>
              <td>
                {canResend(d.status) && (
                  <button
                    type="button"
                    className="secondary"
                    data-testid="delivery-resend"
                    onClick={() => void resend(d.id)}
                  >
                    Resend
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && (
        <p className="ok small" role="status">
          {note}
        </p>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

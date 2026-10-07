import {
  displayValue,
  formatLocal,
  localDate,
  type AnswerValue,
  type Answers,
  type Field,
  type FormDefinition,
  type ImageValue,
  type Option,
} from '@fieldforms/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type PublishedForm } from '../lib/api';
import { useBlobUrl } from '../lib/useBlobUrl';

interface SubmissionRow {
  id: string;
  form_id: string;
  form_name: string;
  version: number;
  site_name: string | null;
  submitted_by_name: string | null;
  server_received_at: string;
  device_captured_at: string | null;
  clock_skew_flag: boolean;
  sync_delay_flag: boolean;
  dispatch_title: string | null;
}

export function SubmissionsPage() {
  const today = localDate(new Date());
  const [filter, setFilter] = useState({ from: today, to: today, formId: '' });
  const forms = useQuery({ queryKey: ['forms'], queryFn: () => api<PublishedForm[]>('/forms') });
  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: filter.from, to: filter.to });
    if (filter.formId) p.set('formId', filter.formId);
    return p.toString();
  }, [filter]);
  const list = useQuery({
    queryKey: ['submissions', qs],
    queryFn: () => api<SubmissionRow[]>(`/form-submissions?${qs}`),
  });

  return (
    <div className="stack">
      <div className="card filters">
        <label>
          Form
          <select
            value={filter.formId}
            onChange={(e) => setFilter({ ...filter, formId: e.target.value })}
          >
            <option value="">All forms</option>
            {forms.data?.map((f) => (
              <option key={f.formId} value={f.formId}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From{' '}
          <input
            type="date"
            value={filter.from}
            onChange={(e) => setFilter({ ...filter, from: e.target.value })}
          />
        </label>
        <label>
          To{' '}
          <input
            type="date"
            value={filter.to}
            onChange={(e) => setFilter({ ...filter, to: e.target.value })}
          />
        </label>
      </div>
      {list.error && <p className="error">{(list.error as Error).message}</p>}
      <div className="card scroll">
        <table className="report" data-testid="submissions">
          <thead>
            <tr>
              <th>Received</th>
              <th>Form</th>
              <th>Site</th>
              <th>By</th>
              <th>Task</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data?.map((s) => (
              <tr key={s.id}>
                <td className="nowrap">{formatLocal(s.server_received_at)}</td>
                <td>
                  {s.form_name} <span className="muted small">v{s.version}</span>
                </td>
                <td>{s.site_name ?? '—'}</td>
                <td>{s.submitted_by_name}</td>
                <td className="small">{s.dispatch_title ?? ''}</td>
                <td>
                  {s.clock_skew_flag && <span className="flag bad">Clock skew</span>}
                  {s.sync_delay_flag && <span className="flag info">Late sync</span>}{' '}
                  <Link to={`/submissions/${s.id}`}>Open</Link>
                </td>
              </tr>
            ))}
            {list.data && !list.data.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No submissions in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Detail {
  submission: {
    id: string;
    data: Answers;
    form_name: string;
    site_name: string | null;
    submitted_by_name: string | null;
    server_received_at: string;
    device_captured_at: string | null;
    clock_skew_flag: boolean;
    clock_skew_seconds: number | null;
    sync_delay_flag: boolean;
    dispatch_title: string | null;
  };
  definition: FormDefinition;
  version: number;
  lists: Record<string, Option[]>;
}

export function SubmissionDetailPage() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['submission', id],
    queryFn: () => api<Detail>(`/form-submissions/${id}`),
  });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error || !q.data)
    return <p className="error">{(q.error as Error)?.message ?? 'Not found'}</p>;
  const { submission: s, definition, version, lists } = q.data;
  const json = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(q.data, null, 2))}`;

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <h2>
            {s.form_name} <span className="muted small">version {version}</span>
          </h2>
          <a className="button secondary" href={json} download={`submission-${s.id}.json`}>
            Download JSON
          </a>
        </div>
        <dl className="facts">
          {s.dispatch_title && (
            <>
              <dt>Task</dt>
              <dd>{s.dispatch_title}</dd>
            </>
          )}
          <dt>Site</dt>
          <dd>{s.site_name ?? '—'}</dd>
          <dt>Submitted by</dt>
          <dd>{s.submitted_by_name}</dd>
          <dt>Filled in on device</dt>
          <dd>
            {s.device_captured_at ? formatLocal(s.device_captured_at, 'yyyy-MM-dd HH:mm:ss') : '—'}
          </dd>
          <dt>Received by server</dt>
          <dd>
            {formatLocal(s.server_received_at, 'yyyy-MM-dd HH:mm:ss')}
            {s.clock_skew_flag && (
              <span className="flag bad">
                Device clock off by {Math.round((s.clock_skew_seconds ?? 0) / 60)} min
              </span>
            )}
            {s.sync_delay_flag && <span className="flag info">Synced late</span>}
          </dd>
        </dl>
      </div>
      <div className="card answers" data-testid="answers">
        {definition.fields.map((f) => (
          <Answer key={f.id} field={f} value={s.data[f.id]} lists={lists} />
        ))}
      </div>
    </div>
  );
}

function Answer({
  field: f,
  value,
  lists,
}: {
  field: Field;
  value: AnswerValue | undefined;
  lists: Record<string, Option[]>;
}) {
  if (f.type === 'note' || value === undefined) return null;
  if (f.type === 'group') {
    const rows = (Array.isArray(value) ? value : []) as Answers[];
    return (
      <div className="answer">
        <div className="answer-label">{f.label}</div>
        {rows.length ? (
          <table className="report">
            <thead>
              <tr>
                {f.fields
                  .filter((c) => c.type !== 'note')
                  .map((c) => (
                    <th key={c.id}>{c.label}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {f.fields
                    .filter((c) => c.type !== 'note')
                    .map((c) => (
                      <td key={c.id}>
                        <AnswerValueView field={c} value={r[c.id]} lists={lists} />
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">No rows</span>
        )}
      </div>
    );
  }
  return (
    <div className="answer" data-testid={`answer-${f.id}`}>
      <div className="answer-label">{f.label}</div>
      <AnswerValueView field={f} value={value} lists={lists} />
    </div>
  );
}

function AnswerValueView({
  field,
  value,
  lists,
}: {
  field: Field;
  value: AnswerValue | undefined;
  lists: Record<string, Option[]>;
}) {
  if (field.type === 'image' && Array.isArray(value)) {
    return (
      <div className="thumbs">
        {(value as ImageValue[]).map((img) => (
          <Photo key={img.blobId} img={img} />
        ))}
      </div>
    );
  }
  if (field.type === 'signature' && value && typeof value === 'object' && 'blobId' in value) {
    return <SignatureView blobId={(value as { blobId: string }).blobId} />;
  }
  if (field.type === 'geotag' && value && typeof value === 'object' && 'lat' in value) {
    const g = value as { lat: number; lng: number };
    return (
      <a
        href={`https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=17/${g.lat}/${g.lng}`}
        target="_blank"
        rel="noreferrer"
      >
        {displayValue(field, value, lists)}
      </a>
    );
  }
  return <span>{displayValue(field, value, lists) || <span className="muted">—</span>}</span>;
}

/** The original photo with its markup layer on top; either can be opened on its own. */
function Photo({ img }: { img: ImageValue }) {
  const photo = useBlobUrl(img.blobId);
  const layer = useBlobUrl(img.annotationBlobId);
  return (
    <div className="thumb large">
      <div className="stack-img">
        {photo && <img src={photo} alt="Photo" />}
        {layer && <img src={layer} alt="Markup" className="layer" />}
      </div>
      <div className="small">
        {photo && (
          <a href={photo} target="_blank" rel="noreferrer">
            Original
          </a>
        )}
        {layer && (
          <>
            {' · '}
            <a href={layer} target="_blank" rel="noreferrer">
              Markup only
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function SignatureView({ blobId }: { blobId: string }) {
  const url = useBlobUrl(blobId);
  return url ? <img className="signature-img" src={url} alt="Signature" /> : null;
}

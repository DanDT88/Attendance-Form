import { filesOf, type Answers, type FormDefinition } from '@fieldforms/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import type { Bootstrap, InboxItem, PublishedForm } from '../lib/api';
import { refreshBootstrap, useAuth } from '../lib/auth';
import { cacheGet, cacheSet, discardDraft, localDb } from '../offline/db';

/** Starts a draft for a form (or a dispatched task) and returns its id. */
export async function startDraft(
  ownerId: string,
  form: { formId: string; versionId: string; name: string; definition: FormDefinition },
  task?: InboxItem,
): Promise<string> {
  const id = crypto.randomUUID();
  // Keep the exact version with the draft, so it can be finished offline even after a new
  // version is published.
  await cacheSet(`formVersion:${form.versionId}`, { name: form.name, definition: form.definition });
  const now = Date.now();
  await localDb.drafts.add({
    id,
    ownerId,
    formId: form.formId,
    versionId: form.versionId,
    dispatchId: task?.id ?? null,
    siteId: task?.site_id ?? null,
    title: task?.title ?? form.name,
    answers: (task?.prefill as Answers) ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export function FormsPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const boot = useLiveQuery(() => cacheGet<Bootstrap>('bootstrap'), []);
  const drafts = useLiveQuery(
    () => (me ? localDb.drafts.where('ownerId').equals(me.id).reverse().sortBy('updatedAt') : []),
    [me?.id],
  );
  // Tasks already submitted from this phone stay hidden until the server confirms them done.
  const submittedTasks = useLiveQuery(async () => {
    const items = await localDb.outbox.where('status').notEqual('failed').toArray();
    return new Set(
      items.map((i) => (i.payload as { dispatchId?: string }).dispatchId).filter(Boolean),
    );
  }, []);

  if (!me) return null;
  if (!boot) {
    return (
      <div className="card">
        <p>This phone has not downloaded any forms yet. Connect to the internet once.</p>
        <button onClick={() => void refreshBootstrap()}>Try again</button>
      </div>
    );
  }

  const forms: PublishedForm[] = boot.forms ?? [];
  const inbox = (boot.inbox ?? []).filter((t) => !submittedTasks?.has(t.id));
  const draftFor = (taskId: string) => drafts?.find((d) => d.dispatchId === taskId);
  const office = me.role !== 'supervisor';

  return (
    <div className="stack">
      {inbox.length > 0 && (
        <section className="card stack" data-testid="inbox">
          <h3>Tasks for you</h3>
          <ul className="list">
            {inbox.map((t) => {
              const draft = draftFor(t.id);
              return (
                <li key={t.id} data-testid="task">
                  <div>
                    <b>{t.title}</b>
                    <div className="small muted">
                      {t.form_name}
                      {t.site_name ? ` · ${t.site_name}` : ''}
                      {t.due_on ? ` · due ${t.due_on}` : ''}
                      {t.created_by_name ? ` · from ${t.created_by_name}` : ''}
                    </div>
                    {t.instructions && <div className="small">{t.instructions}</div>}
                  </div>
                  <button
                    onClick={async () =>
                      navigate(
                        `/forms/fill/${draft?.id ?? (await startDraft(me.id, { formId: t.form_id, versionId: t.form_version_id, name: t.form_name, definition: t.definition }, t))}`,
                      )
                    }
                  >
                    {draft ? 'Continue' : 'Start'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!!drafts?.length && (
        <section className="card stack" data-testid="drafts">
          <h3>Drafts on this phone</h3>
          <ul className="list">
            {drafts.map((d) => (
              <li key={d.id} data-testid="draft">
                <div>
                  <b>{d.title}</b>
                  <div className="small muted">
                    Saved {new Date(d.updatedAt).toLocaleString('en-ZA')}
                  </div>
                </div>
                <span>
                  <Link className="button" to={`/forms/fill/${d.id}`}>
                    Continue
                  </Link>{' '}
                  <button
                    className="link"
                    onClick={async () => {
                      if (!confirm('Discard this draft and its photos?')) return;
                      const def = (
                        await cacheGet<{ definition: FormDefinition }>(`formVersion:${d.versionId}`)
                      )?.definition;
                      const blobIds = def
                        ? filesOf(def, d.answers as Answers).map((f) => f.blobId)
                        : [];
                      await discardDraft(d.id, blobIds);
                    }}
                  >
                    Discard
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card stack">
        <h3>Forms</h3>
        {!forms.length && <p className="muted">No forms have been published yet.</p>}
        <ul className="list">
          {forms.map((f) => (
            <li key={f.formId} data-testid="form">
              <div>
                <b>{f.name}</b>
                <div className="small muted">
                  Version {f.version}
                  {f.definition.description ? ` · ${f.definition.description}` : ''}
                </div>
              </div>
              <span className="nowrap">
                {office && (
                  <Link className="button secondary" to={`/dispatch/${f.formId}`}>
                    Send as task
                  </Link>
                )}{' '}
                <button onClick={async () => navigate(`/forms/fill/${await startDraft(me.id, f)}`)}>
                  Fill in
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import {
  evaluateForm,
  filesOf,
  type Answers,
  type FormDefinition,
  type Option,
} from '@fieldforms/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FormRenderer } from '../components/form/FormRenderer';
import type { Bootstrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cacheGet, localDb, submitDraft, type DraftRow } from '../offline/db';
import { requestSync } from '../offline/sync';

const AUTOSAVE_MS = 400;
const NO_LISTS: Record<string, Option[]> = {};

export function FillFormPage() {
  const { draftId } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const draft = useLiveQuery(() => localDb.drafts.get(draftId!), [draftId]);
  const boot = useLiveQuery(() => cacheGet<Bootstrap>('bootstrap'), []);
  const version = useLiveQuery(
    async () =>
      draft
        ? await cacheGet<{ name: string; definition: FormDefinition }>(
            `formVersion:${draft.versionId}`,
          )
        : undefined,
    [draft?.versionId],
  );

  if (draft === undefined || boot === undefined) return <p className="muted">Loading…</p>;
  if (!draft) return <p className="card">This draft has been submitted or discarded.</p>;
  if (!version)
    return (
      <p className="card error">
        This form's definition is not on this phone. Connect and open it again.
      </p>
    );
  if (!me) return null;
  return (
    <Filler
      key={draft.id}
      draft={draft}
      def={version.definition}
      boot={boot}
      ownerId={me.id}
      onDone={() => navigate('/outbox')}
    />
  );
}

function Filler({
  draft,
  def,
  boot,
  ownerId,
  onDone,
}: {
  draft: DraftRow;
  def: FormDefinition;
  boot: Bootstrap;
  ownerId: string;
  onDone(): void;
}) {
  // The draft is read once; after that this component owns the answers and saves them back.
  const [answers, setAnswers] = useState<Answers>(draft.answers as Answers);
  const [siteId, setSiteId] = useState<string>(
    draft.siteId ?? (boot.sites.length === 1 ? boot.sites[0]!.id : ''),
  );
  const [showAll, setShowAll] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'saving'>('saved');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lists = boot.lists ?? NO_LISTS;
  const state = useMemo(() => evaluateForm(def, answers, { lists }), [def, answers, lists]);

  // Save as the user types, so closing the app or losing battery loses nothing.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setSaved('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await localDb.drafts.update(draft.id, {
        answers,
        siteId: siteId || null,
        updatedAt: Date.now(),
      });
      setSaved('saved');
    }, AUTOSAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [answers, siteId, draft.id]);

  const siteMissing = def.settings.siteRequired && !siteId;

  async function submit() {
    setShowAll(true);
    setMessage(null);
    if (siteMissing || !state.valid) {
      setMessage(
        siteMissing
          ? 'Choose the site first.'
          : `Please fix ${state.errors.length} problem${state.errors.length > 1 ? 's' : ''} highlighted below.`,
      );
      const first = siteMissing ? 'site' : state.errors[0]?.path;
      document
        .querySelector(`[data-field="${first}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setBusy(true);
    try {
      const blobIds = [...new Set(filesOf(def, state.values).map((f) => f.blobId))];
      const site = boot.sites.find((s) => s.id === siteId);
      await submitDraft(
        draft.id,
        {
          type: 'form',
          ownerId,
          label: `${draft.title}${site ? ` · ${site.name}` : ''}`,
          payload: {
            id: draft.id,
            formVersionId: draft.versionId,
            dispatchId: draft.dispatchId,
            siteId: siteId || null,
            answers: state.values,
            deviceCapturedAt: new Date().toISOString(),
          },
        },
        blobIds,
      );
      requestSync();
      onDone();
    } catch (err) {
      setMessage((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack fill-form">
      <div className="card">
        <div className="row">
          <h2>{draft.title}</h2>
          <span className="small muted" data-testid="autosave">
            {saved === 'saved' ? 'Draft saved on this phone' : 'Saving…'}
          </span>
        </div>
        {draft.title !== def.title && <div className="small muted">{def.title}</div>}
        {def.description && <p className="muted">{def.description}</p>}
        {def.settings.siteRequired && (
          <label data-field="site">
            Site *
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              data-testid="form-site"
            >
              <option value="">Choose…</option>
              {boot.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.company_name})
                </option>
              ))}
            </select>
            {showAll && siteMissing && <span className="error small">Required</span>}
          </label>
        )}
      </div>
      <div className="card">
        <FormRenderer
          def={def}
          answers={answers}
          onChange={setAnswers}
          state={state}
          lists={lists}
          showAllErrors={showAll}
        />
      </div>
      <div className="card stack">
        {message && (
          <p className="error" data-testid="form-message">
            {message}
          </p>
        )}
        <button onClick={() => void submit()} disabled={busy} data-testid="form-submit">
          {busy ? 'Saving…' : 'Submit'}
        </button>
        <p className="small muted">
          Submitting puts the form in the outbox; it is sent as soon as there is signal.
        </p>
      </div>
    </div>
  );
}

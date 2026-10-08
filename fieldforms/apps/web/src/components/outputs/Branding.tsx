import { useState } from 'react';
import { brandingApi, type CompanyRow } from '../../lib/api';
import { useBlobUrl } from '../../lib/useBlobUrl';
import { ErrorBox } from './common';

const COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * A company's document branding: colour, logo (PNG or JPEG, uploaded as a blob first) and a
 * footer. Empty values fall back to the brand name and colour in Settings.
 */
export function CompanyBranding({ company, onSaved }: { company: CompanyRow; onSaved(): void }) {
  const [colour, setColour] = useState(company.brand_colour ?? '');
  const [footer, setFooter] = useState(company.document_footer ?? '');
  const [logo, setLogo] = useState<string | null>(company.logo_blob_id ?? null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const logoUrl = useBlobUrl(logo ?? undefined);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await brandingApi.setCompany(company.id, {
        brandColour: colour.trim() || null,
        logoBlobId: logo,
        documentFooter: footer.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" data-testid="company-branding">
      <div className="grid2">
        <label>
          Brand colour <span className="muted small">(empty: the Settings colour)</span>
          <span className="row-start">
            <input
              type="color"
              aria-label="Pick a colour"
              value={COLOUR.test(colour) ? colour : '#1b365d'}
              onChange={(e) => setColour(e.target.value)}
            />
            <input
              value={colour}
              placeholder="#1B365D"
              maxLength={7}
              className="mono"
              onChange={(e) => setColour(e.target.value)}
            />
          </span>
        </label>
        <label>
          Logo (PNG or JPEG)
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setError(null);
              setBusy(true);
              brandingApi
                .uploadLogo(f)
                .then(setLogo)
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          />
          {logoUrl && <img src={logoUrl} alt="Logo" style={{ maxHeight: 48, maxWidth: 200 }} />}
          {logo && (
            <button type="button" className="link small" onClick={() => setLogo(null)}>
              Remove the logo
            </button>
          )}
        </label>
      </div>
      <label>
        Document footer
        <textarea
          rows={2}
          maxLength={500}
          value={footer}
          onChange={(e) => setFooter(e.target.value)}
        />
      </label>
      {colour && !COLOUR.test(colour) && (
        <p className="error small">A colour like #1B365D.</p>
      )}
      <ErrorBox error={error} />
      <div>
        <button
          type="button"
          disabled={busy || (!!colour && !COLOUR.test(colour))}
          onClick={() => void save()}
          data-testid="branding-save"
        >
          Save branding
        </button>
      </div>
    </div>
  );
}

import { DeliveryError, type ConnectionDriver } from '../types.js';
import {
  DRIVE_SCOPE,
  googleAccessToken,
  googleSecretSchema,
  serviceAccountOf,
  SHEETS_SCOPE,
  type GoogleConfig,
} from '../vendors/google-auth.js';

/**
 * A Google service account, for Drive and Sheets. The check signs in and shows the service
 * account's address: the admin shares the Shared Drive folder or the spreadsheet with it.
 */
export const googleDriver: ConnectionDriver<GoogleConfig> = {
  kind: 'google',
  secretSchema: googleSecretSchema,
  async check(conn, env) {
    const sa = serviceAccountOf(conn);
    const subject = conn.config.subject;
    // Without a subject any scope signs in. With domain-wide delegation each scope must be
    // granted to the client id, so try both and say which one is missing.
    const allowed: string[] = [];
    const refused: string[] = [];
    let firstError: unknown = null;
    for (const [label, scope] of [
      ['Drive', DRIVE_SCOPE],
      ['Sheets', SHEETS_SCOPE],
    ] as const) {
      try {
        await googleAccessToken(conn, scope, env);
        allowed.push(label);
      } catch (err) {
        if (!(err instanceof DeliveryError) || err.errorClass !== 'credentials') throw err;
        refused.push(label);
        firstError ??= err;
      }
    }
    if (!allowed.length) throw firstError;
    const facts: Record<string, string> = { serviceAccountEmail: sa.clientEmail };
    if (subject) facts.actingAs = subject;
    return {
      ok: true,
      summary: `Signed in as ${sa.clientEmail}${subject ? ` acting as ${subject}` : ''}. Share the Shared Drive folder or the spreadsheet with this address.`,
      facts,
      warnings: refused.map(
        (label) =>
          `Google did not allow ${label} access for ${subject ?? 'this account'}: grant its scope to the service account's client id (domain-wide delegation)`,
      ),
    };
  },
};

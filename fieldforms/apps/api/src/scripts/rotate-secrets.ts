import { createDb } from '../db/index.js';
import { createSecretOpener } from '../lib/secrets.js';
import { audit } from '../services/audit.js';

/**
 * Re-seals every stored connection secret with the current key pair after a rotation. Run it in
 * the worker's environment with the new SECRETS_PRIVATE_KEY and the old one as
 * SECRETS_PRIVATE_KEY_PREVIOUS; afterwards the previous key can be removed. Safe to run again.
 */
const url = process.env.DATABASE_URL;
if (!url || !process.env.SECRETS_PRIVATE_KEY) {
  console.error(
    'Set DATABASE_URL, SECRETS_PRIVATE_KEY and (during a rotation) SECRETS_PRIVATE_KEY_PREVIOUS.',
  );
  process.exit(1);
}
const opener = createSecretOpener(
  process.env.SECRETS_PRIVATE_KEY,
  process.env.SECRETS_PRIVATE_KEY_PREVIOUS,
);
const { db } = createDb(url);
let resealed = 0;
let failed = 0;
try {
  const rows = await db
    .selectFrom('connections')
    .select(['id', 'name', 'secrets'])
    .where('secrets', 'is not', null)
    .execute();
  for (const r of rows) {
    if (!opener.needsRotation(r.secrets!)) continue;
    try {
      const plain = opener.open(r.secrets!, `connection:${r.id}`);
      await db
        .updateTable('connections')
        .set({ secrets: opener.seal(plain, `connection:${r.id}`) })
        .where('id', '=', r.id)
        .where('secrets', '=', r.secrets)
        .execute();
      resealed++;
    } catch {
      failed++;
      console.error(
        `Could not open the secrets of "${r.name}" with either key; re-enter them in the app.`,
      );
    }
  }
  await audit(
    db,
    { actorUserId: null },
    {
      action: 'secrets.rotate',
      details: { resealed, failed, keyId: opener.keyId },
    },
  );
  console.log(
    `Re-sealed ${resealed} connection secret(s) with key ${opener.keyId}; ${failed} could not be opened.`,
  );
} finally {
  await db.destroy();
}
process.exit(failed ? 2 : 0);

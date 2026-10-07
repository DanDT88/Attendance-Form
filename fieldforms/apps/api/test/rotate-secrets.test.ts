import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSecretOpener,
  createSecretSealer,
  generateSecretsKeyPair,
} from '../src/lib/secrets.js';
import { createTestContext, type TestContext } from './helpers.js';

const run = promisify(execFile);
const apiDir = fileURLToPath(new URL('..', import.meta.url));
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(async () => t?.close());

describe('rotate-secrets', () => {
  it('re-seals every connection with the new key and keeps the values', async () => {
    const oldKeys = generateSecretsKeyPair();
    const newKeys = generateSecretsKeyPair();
    const id = randomUUID();
    await t.owner
      .insertInto('connections')
      .values({
        id,
        name: 'SFTP',
        kind: 'sftp',
        config: '{}',
        secrets: createSecretSealer(oldKeys.publicKey).seal(
          { password: 'hunter22' },
          `connection:${id}`,
        ),
        secret_keys: ['password'],
      })
      .execute();
    const dbUrl = (t.appPool.options as { connectionString: string }).connectionString;
    const out = await run('npx', ['tsx', 'src/scripts/rotate-secrets.ts'], {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        SECRETS_PRIVATE_KEY: newKeys.privateKey,
        SECRETS_PRIVATE_KEY_PREVIOUS: oldKeys.privateKey,
      },
    });
    expect(out.stdout).toContain('Re-sealed 1 connection secret(s)');
    const row = await t.owner
      .selectFrom('connections')
      .select('secrets')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const fresh = createSecretOpener(newKeys.privateKey);
    expect(fresh.needsRotation(row.secrets!)).toBe(false);
    expect(fresh.open(row.secrets!, `connection:${id}`)).toEqual({ password: 'hunter22' });
    expect(row.secrets).not.toContain('hunter22');
  }, 60_000);
});

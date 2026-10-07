import { describe, expect, it } from 'vitest';
import {
  createSecretOpener,
  createSecretSealer,
  generateSecretsKeyPair,
  SecretsError,
} from '../src/lib/secrets.js';

const k1 = generateSecretsKeyPair();
const k2 = generateSecretsKeyPair();

describe('sealed secrets', () => {
  it('the API seals, only the worker opens, and the plain text is never stored', () => {
    const api = createSecretSealer(k1.publicKey);
    const worker = createSecretOpener(k1.privateKey);
    const stored = api.seal({ password: 'hunter2', token: 'xoxb-123' }, 'destination:abc');
    expect(stored).toMatch(/^v2:[0-9a-f]{8}:/);
    expect(stored).not.toContain('hunter2');
    expect(api).not.toHaveProperty('open');
    expect(worker.open(stored, 'destination:abc')).toEqual({
      password: 'hunter2',
      token: 'xoxb-123',
    });
    expect(api.keyId).toBe(worker.keyId);
  });

  it('uses a fresh ephemeral key each time', () => {
    const api = createSecretSealer(k1.publicKey);
    const a = api.seal({ a: 'b' }, 'x').split(':');
    const b = api.seal({ a: 'b' }, 'x').split(':');
    expect(a[2]).not.toBe(b[2]);
    expect(a[5]).not.toBe(b[5]);
  });

  it('is bound to its row: another AAD or a tampered value does not open', () => {
    const worker = createSecretOpener(k1.privateKey);
    const stored = createSecretSealer(k1.publicKey).seal({ a: 'b' }, 'destination:1');
    expect(() => worker.open(stored, 'destination:2')).toThrow(SecretsError);
    const parts = stored.split(':');
    const data = Buffer.from(parts[5]!, 'base64url');
    data[0] = data[0]! ^ 1;
    parts[5] = data.toString('base64url');
    expect(() => worker.open(parts.join(':'), 'destination:1')).toThrow(
      'A stored secret could not be opened',
    );
  });

  it('opens with the previous key during a rotation and says what to re-seal', () => {
    const stored = createSecretSealer(k1.publicKey).seal({ a: 'b' }, 'x');
    const rotated = createSecretOpener(k2.privateKey, k1.privateKey);
    expect(rotated.open(stored, 'x')).toEqual({ a: 'b' });
    expect(rotated.needsRotation(stored)).toBe(true);
    expect(rotated.needsRotation(rotated.seal({ a: 'b' }, 'x'))).toBe(false);
    expect(() => createSecretOpener(k2.privateKey).open(stored, 'x')).toThrow(
      'key that is not configured',
    );
  });

  it('refuses to seal without a key, and rejects keys of the wrong kind', () => {
    const none = createSecretSealer(undefined);
    expect(none.canSeal).toBe(false);
    expect(() => none.seal({ a: 'b' }, 'x')).toThrow('Set SECRETS_PUBLIC_KEY');
    expect(createSecretOpener(undefined).canOpen).toBe(false);
    expect(() => createSecretSealer(k1.privateKey)).toThrow('not an X25519 public key');
    expect(() => createSecretOpener(k1.publicKey)).toThrow('not an X25519 private key');
  });
});

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Destination secrets (passwords, tokens, service-account keys) are sealed to the worker.
 *
 * The internet-facing API holds only the public key (SECRETS_PUBLIC_KEY): it can seal what an
 * admin types in but can never read a stored secret back. The worker holds the private key
 * (SECRETS_PRIVATE_KEY) and opens secrets only when it delivers or tests a destination.
 *
 * Sealing: an ephemeral X25519 key pair, ECDH with the worker's public key, HKDF-SHA256 to an
 * AES-256-GCM key, with the row (e.g. "destination:<id>") as associated data so a sealed value
 * moved onto another row does not open. Stored form:
 *   v2:<key id>:<ephemeral public key>:<iv>:<tag>:<ciphertext>   (base64url parts)
 * The key id (first 8 hex of SHA-256 of the public key) says which key pair sealed it, so
 * SECRETS_PRIVATE_KEY_PREVIOUS can still open values during a rotation.
 */
export class SecretsError extends Error {
  override readonly name = 'SecretsError';
  readonly permanent = true;
}

export interface SecretSealer {
  readonly canSeal: boolean;
  readonly keyId: string | null;
  seal(plain: Record<string, string>, aad: string): string;
}

export interface SecretOpener extends SecretSealer {
  readonly canOpen: boolean;
  open(stored: string, aad: string): Record<string, string>;
  /** True when the value was sealed to an older key pair and should be re-sealed. */
  needsRotation(stored: string): boolean;
}

const VERSION = 'v2';
const INFO = Buffer.from('fieldforms destination secrets v2');

const rawPublic = (key: KeyObject) =>
  Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url');
const keyIdOf = (pub: KeyObject) =>
  createHash('sha256').update(rawPublic(pub)).digest('hex').slice(0, 8);

function loadPublic(b64: string | undefined): KeyObject | null {
  if (!b64) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error();
    return key;
  } catch {
    throw new SecretsError(
      'SECRETS_PUBLIC_KEY is not an X25519 public key (run pnpm secrets-keygen)',
    );
  }
}

function loadPrivate(b64: string | undefined, name: string): KeyObject | null {
  if (!b64) return null;
  try {
    const key = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error();
    return key;
  } catch {
    throw new SecretsError(`${name} is not an X25519 private key (run pnpm secrets-keygen)`);
  }
}

function aesKey(shared: Buffer, eph: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), INFO, 32));
}

function sealer(pub: KeyObject | null): SecretSealer {
  const keyId = pub ? keyIdOf(pub) : null;
  return {
    canSeal: !!pub,
    keyId,
    seal(plain, aad) {
      if (!pub || !keyId) throw new SecretsError('Set SECRETS_PUBLIC_KEY to store secrets');
      const eph = generateKeyPairSync('x25519');
      const ephRaw = rawPublic(eph.publicKey);
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', aesKey(shared, ephRaw, rawPublic(pub)), iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
      return [VERSION, keyId, ephRaw, iv, cipher.getAuthTag(), data]
        .map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p))
        .join(':');
    },
  };
}

/** For the API: seals only. */
export function createSecretSealer(publicKeyB64: string | undefined): SecretSealer {
  return sealer(loadPublic(publicKeyB64));
}

/** For the worker: seals and opens. The public key is derived from the private key. */
export function createSecretOpener(
  privateKeyB64: string | undefined,
  previousPrivateKeyB64?: string,
): SecretOpener {
  const current = loadPrivate(privateKeyB64, 'SECRETS_PRIVATE_KEY');
  const previous = loadPrivate(previousPrivateKeyB64, 'SECRETS_PRIVATE_KEY_PREVIOUS');
  const keys = new Map<string, KeyObject>();
  for (const k of [current, previous]) if (k) keys.set(keyIdOf(createPublicKey(k)), k);
  const base = sealer(current ? createPublicKey(current) : null);

  return {
    ...base,
    canOpen: !!current,
    open(stored, aad) {
      const parts = stored.split(':');
      if (parts.length !== 6 || parts[0] !== VERSION) throw new SecretsError('Unreadable secret');
      const [, id, eph, iv, tag, data] = parts as [string, string, string, string, string, string];
      const priv = keys.get(id);
      if (!priv) throw new SecretsError('This secret was sealed with a key that is not configured');
      try {
        const ephRaw = Buffer.from(eph, 'base64url');
        const ephKey = createPublicKey({
          key: { kty: 'OKP', crv: 'X25519', x: eph },
          format: 'jwk',
        });
        const shared = diffieHellman({ privateKey: priv, publicKey: ephKey });
        const recipient = rawPublic(createPublicKey(priv));
        const decipher = createDecipheriv(
          'aes-256-gcm',
          aesKey(shared, ephRaw, recipient),
          Buffer.from(iv, 'base64url'),
        );
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(data, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
        const parsed: unknown = JSON.parse(plain);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, string>;
      } catch {
        // Never include the sealed value or key material in the message.
        throw new SecretsError('A stored secret could not be opened');
      }
    },
    needsRotation(stored) {
      return stored.split(':')[1] !== base.keyId;
    },
  };
}

/** A new key pair, base64 DER: the public key for the API, the private key for the worker. */
export function generateSecretsKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

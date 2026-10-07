import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP's recommended minimum (19 MiB, 2 passes, 1 lane).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, OPTIONS);
}

export async function verifySecret(storedHash: string | null, secret: string): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}

/**
 * A hash of a random value, verified against when the user does not exist, so a sign-in for an
 * unknown account takes as long as one for a real account and does not reveal which exist.
 */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(secret: string): Promise<boolean> {
  dummyHash ??= hashSecret(`dummy-${Math.random()}`);
  return dummyHash.then((h) => verifySecret(h, secret));
}

export const PIN_PATTERN = /^\d{6}$/;
export const PASSWORD_MIN_LENGTH = 12;

export function validatePassword(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  return null;
}

export function validatePin(pin: string): string | null {
  if (!PIN_PATTERN.test(pin)) return 'PIN must be exactly 6 digits';
  // Refuse the most guessable PINs.
  if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    return 'PIN is too easy to guess';
  }
  return null;
}

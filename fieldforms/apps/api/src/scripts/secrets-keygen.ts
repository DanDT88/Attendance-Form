import { generateSecretsKeyPair } from '../lib/secrets.js';

/**
 * Prints a new key pair for destination secrets. Put SECRETS_PUBLIC_KEY in the API's
 * environment and SECRETS_PRIVATE_KEY in the worker's only: the API seals what admins type in,
 * and only the worker can open it.
 */
const { publicKey, privateKey } = generateSecretsKeyPair();
console.log(`SECRETS_PUBLIC_KEY=${publicKey}`);
console.log(`SECRETS_PRIVATE_KEY=${privateKey}`);

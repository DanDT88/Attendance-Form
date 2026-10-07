import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Public URL of the app, used for OIDC redirects and links in emails. */
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),

  /** The API's own connection, as the restricted fieldforms_app role. */
  DATABASE_URL: z.string().min(1),
  /** Owner connection, used only by the migration runner. */
  MIGRATION_DATABASE_URL: z.string().optional(),

  COOKIE_SECURE: bool,
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  TRUST_PROXY: bool,

  BLOB_STORE: z.enum(['s3', 'local']).default('local'),
  BLOB_LOCAL_DIR: z.string().default('./data/blobs'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('fieldforms'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  MAX_PHOTO_BYTES: z.coerce
    .number()
    .int()
    .default(5 * 1024 * 1024),

  /** Comma-separated provider ids, e.g. "microsoft,google". Each needs the three OIDC_<ID>_* vars. */
  OIDC_PROVIDERS: z.string().default(''),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),

  // ---- Phase 3: documents, destinations, public API

  /** Gotenberg (HTML → PDF). Without it, PDF documents cannot be made. */
  GOTENBERG_URL: z.string().url().optional(),
  GOTENBERG_USERNAME: z.string().optional(),
  GOTENBERG_PASSWORD: z.string().optional(),
  /** X25519 public key (API): seals destination secrets. See `pnpm secrets-keygen`. */
  SECRETS_PUBLIC_KEY: z.string().optional(),
  /** X25519 private key (worker only): opens them. Never give it to the API. */
  SECRETS_PRIVATE_KEY: z.string().optional(),
  SECRETS_PRIVATE_KEY_PREVIOUS: z.string().optional(),
  /** Private ranges destinations may reach, e.g. "10.20.0.0/16" for an on-premises server. */
  DESTINATIONS_ALLOWED_PRIVATE_CIDRS: z.string().default(''),
  /** Allow this server's own networks (development only: lets destinations reach other containers). */
  DESTINATIONS_ALLOW_SAME_NETWORK: bool,
  /** Parallel deliveries per worker. */
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Larger documents are linked rather than attached to emails. */
  EMAIL_ATTACHMENT_LIMIT_MB: z.coerce.number().min(1).max(50).default(10),
  /** Public REST API: requests per minute per key. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
});

export type Config = z.infer<typeof envSchema> & {
  oidc: OidcProviderConfig[];
};

export interface OidcProviderConfig {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const cfg = parsed.data;
  const oidc = cfg.OIDC_PROVIDERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      const key = id.toUpperCase();
      const issuer = env[`OIDC_${key}_ISSUER`];
      const clientId = env[`OIDC_${key}_CLIENT_ID`];
      const clientSecret = env[`OIDC_${key}_CLIENT_SECRET`];
      if (!issuer || !clientId || !clientSecret) {
        throw new Error(
          `OIDC provider "${id}" needs OIDC_${key}_ISSUER, _CLIENT_ID and _CLIENT_SECRET`,
        );
      }
      return { id, label: env[`OIDC_${key}_LABEL`] ?? id, issuer, clientId, clientSecret };
    });
  return { ...cfg, oidc };
}

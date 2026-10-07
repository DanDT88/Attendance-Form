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

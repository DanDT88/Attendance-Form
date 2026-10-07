import type { ConnectionDriver } from '../types.js';
import {
  microsoftAccessToken,
  microsoftSecretSchema,
  tokenRoles,
  type MicrosoftConfig,
} from '../vendors/microsoft-auth.js';

/** Permissions that reach every site or drive in the tenant (Sites.Selected is enough). */
const BROAD = /^(Sites\.(ReadWrite|FullControl|Manage)\.All|Files\.ReadWrite\.All)$/;

/**
 * A Microsoft Entra app, for OneDrive and SharePoint. The check signs in (app-only); reading
 * `/organization` is not needed and is often denied to a least-privilege app. The token's
 * application permissions are listed, with a warning for tenant-wide ones.
 */
export const microsoftDriver: ConnectionDriver<MicrosoftConfig> = {
  kind: 'microsoft',
  secretSchema: microsoftSecretSchema,
  async check(conn, env) {
    const token = await microsoftAccessToken(conn, env);
    const roles = tokenRoles(token);
    const facts: Record<string, string> = { tenant: conn.config.tenantId };
    if (roles?.length) facts.permissions = roles.join(', ');
    const warnings: string[] = [];
    if (roles && !roles.length)
      warnings.push(
        'The app has no application permissions yet: grant Sites.Selected (and access to the site) or Files.ReadWrite.All',
      );
    const broad = (roles ?? []).filter((r) => BROAD.test(r));
    if (broad.length)
      warnings.push(
        `${broad.join(', ')} reaches every site in the tenant; Sites.Selected limits the app to the sites you grant`,
      );
    return { ok: true, summary: `Signed in to tenant ${conn.config.tenantId}`, facts, warnings };
  },
};

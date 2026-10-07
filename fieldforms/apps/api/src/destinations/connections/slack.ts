import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const slackDriver: ConnectionDriver = {
  kind: 'slack',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The slack connection check is not built yet');
  },
};

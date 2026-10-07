import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const webhookDriver: ConnectionDriver = {
  kind: 'webhook',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The webhook connection check is not built yet');
  },
};

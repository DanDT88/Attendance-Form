import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const sqlDriver: ConnectionDriver = {
  kind: 'sql',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The sql connection check is not built yet');
  },
};

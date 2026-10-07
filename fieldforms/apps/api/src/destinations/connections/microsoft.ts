import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const microsoftDriver: ConnectionDriver = {
  kind: 'microsoft',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The microsoft connection check is not built yet');
  },
};

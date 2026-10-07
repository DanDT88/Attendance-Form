import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const googleDriver: ConnectionDriver = {
  kind: 'google',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The google connection check is not built yet');
  },
};

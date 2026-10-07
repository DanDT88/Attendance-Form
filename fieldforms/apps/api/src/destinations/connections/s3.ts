import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const s3Driver: ConnectionDriver = {
  kind: 's3',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The s3 connection check is not built yet');
  },
};

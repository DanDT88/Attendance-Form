import { z } from 'zod';
import type { ConnectionDriver } from '../types.js';

export const sftpDriver: ConnectionDriver = {
  kind: 'sftp',
  secretSchema: z.record(z.string(), z.string()),
  async check() {
    throw new Error('The sftp connection check is not built yet');
  },
};

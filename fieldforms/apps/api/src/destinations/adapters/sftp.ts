import type { DestinationAdapter } from '../types.js';

export const sftpAdapter: DestinationAdapter = {
  kind: 'sftp',
  async deliver() {
    throw new Error('The sftp adapter is not built yet');
  },
};

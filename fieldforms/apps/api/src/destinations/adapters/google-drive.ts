import type { DestinationAdapter } from '../types.js';

export const googleDriveAdapter: DestinationAdapter = {
  kind: 'google_drive',
  async deliver() {
    throw new Error('The google_drive adapter is not built yet');
  },
};

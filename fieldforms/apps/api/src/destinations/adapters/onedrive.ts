import type { DestinationAdapter } from '../types.js';

export const onedriveAdapter: DestinationAdapter = {
  kind: 'onedrive',
  async deliver() {
    throw new Error('The onedrive adapter is not built yet');
  },
};

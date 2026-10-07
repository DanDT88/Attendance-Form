import type { DestinationAdapter } from '../types.js';

export const googleSheetsAdapter: DestinationAdapter = {
  kind: 'google_sheets',
  async deliver() {
    throw new Error('The google_sheets adapter is not built yet');
  },
};

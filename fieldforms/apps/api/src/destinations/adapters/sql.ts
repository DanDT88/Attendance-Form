import type { DestinationAdapter } from '../types.js';

export const sqlAdapter: DestinationAdapter = {
  kind: 'sql',
  async deliver() {
    throw new Error('The sql adapter is not built yet');
  },
};

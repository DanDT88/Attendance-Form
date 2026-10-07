import type { DestinationAdapter } from '../types.js';

export const emailAdapter: DestinationAdapter = {
  kind: 'email',
  async deliver() {
    throw new Error('The email adapter is not built yet');
  },
};

import type { DestinationAdapter } from '../types.js';

export const slackAdapter: DestinationAdapter = {
  kind: 'slack',
  async deliver() {
    throw new Error('The slack adapter is not built yet');
  },
};

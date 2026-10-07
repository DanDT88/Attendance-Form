import type { DestinationAdapter } from '../types.js';

export const webhookAdapter: DestinationAdapter = {
  kind: 'webhook',
  async deliver() {
    throw new Error('The webhook adapter is not built yet');
  },
};

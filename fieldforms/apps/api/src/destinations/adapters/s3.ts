import type { DestinationAdapter } from '../types.js';

export const s3Adapter: DestinationAdapter = {
  kind: 's3',
  async deliver() {
    throw new Error('The s3 adapter is not built yet');
  },
};

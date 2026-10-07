import type { Renderer } from '../types.js';

/** JSON: the canonical submission document (schema fieldforms.submission/1). */
export const jsonRenderer: Renderer = {
  format: 'json',
  async render() {
    throw new Error('The json renderer is not built yet');
  },
};

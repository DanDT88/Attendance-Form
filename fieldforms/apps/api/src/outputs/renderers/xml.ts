import type { Renderer } from '../types.js';

/** XML: the same structure as JSON, with <field id="…" type="…"> elements. */
export const xmlRenderer: Renderer = {
  format: 'xml',
  async render() {
    throw new Error('The xml renderer is not built yet');
  },
};

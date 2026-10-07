import type { Renderer } from '../types.js';

/** Excel: the built-in layout (exceljs), repeat groups on their own sheets. */
export const xlsxRenderer: Renderer = {
  format: 'xlsx',
  async render() {
    throw new Error('The xlsx renderer is not built yet');
  },
};

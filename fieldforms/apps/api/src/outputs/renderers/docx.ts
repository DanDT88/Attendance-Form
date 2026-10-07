import type { Renderer } from '../types.js';

/** Word: the built-in layout (docx) or a Word template (docxtemplater, in-house photo module). */
export const docxRenderer: Renderer = {
  format: 'docx',
  async render() {
    throw new Error('The docx renderer is not built yet');
  },
};

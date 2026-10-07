import type { Renderer } from '../types.js';

/** Photos with their markup composited (plus originals when included) and signatures. */
export const imagesRenderer: Renderer = {
  format: 'images',
  async render() {
    throw new Error('The images renderer is not built yet');
  },
};

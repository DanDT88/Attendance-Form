import { mediaRefs, type MediaRef } from '@fieldforms/shared';
import { mapLimit } from '../media.js';
import { IMAGES_MAX_SIDE, type LoadedImage, type RenderedFile, type Renderer } from '../types.js';

const PARALLEL_LOADS = 4;

const ext = (img: LoadedImage) => (img.contentType === 'image/png' ? 'png' : 'jpg');

/**
 * Photos with their markup composited (plus originals when included) and signatures. Files are
 * named `<stem>_<media name>.<ext>` (originals `..._original.<ext>`) and listed in document
 * order, so a retry or another destination gets the same names. Missing files are left out.
 */
export const imagesRenderer: Renderer = {
  format: 'images',
  async render(model, _template, stem, ctx) {
    const refs = mediaRefs(model);
    const perRef = await mapLimit(refs, PARALLEL_LOADS, async (ref: MediaRef) => {
      const files: RenderedFile[] = [];
      const shown = await ctx.media.load(ref, { maxSide: IMAGES_MAX_SIDE });
      if (shown) {
        files.push({
          filename: `${stem}_${ref.name}.${ext(shown)}`,
          contentType: shown.contentType,
          data: shown.data,
        });
      }
      if (ref.kind === 'photo' && ref.includeOriginal) {
        const original = await ctx.media.original(ref);
        if (original) {
          files.push({
            filename: `${stem}_${ref.name}_original.${ext(original)}`,
            contentType: original.contentType,
            data: original.data,
          });
        }
      }
      return files;
    });
    return perRef.flat();
  },
};

import { renderDefaultDocx } from '../docx/default-layout.js';
import { renderDocxTemplate, TemplateProblems } from '../docx/template.js';
import { RenderError, type Renderer } from '../types.js';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Word: the built-in layout (docx), or a Word template (docxtemplater with a names-only parser
 * and the in-house photo module). The PDF renderer converts this output for Word templates.
 */
export const docxRenderer: Renderer = {
  format: 'docx',
  async render(model, template, stem, ctx) {
    ctx.signal.throwIfAborted();
    let data: Buffer;
    if (!template) {
      data = await renderDefaultDocx(model, ctx);
    } else if (template.kind !== 'docx') {
      throw new RenderError('An HTML template cannot make a Word document; use a Word template');
    } else if (!Buffer.isBuffer(template.content)) {
      throw new RenderError(`Word template version ${template.version} could not be read`);
    } else {
      try {
        data = await renderDocxTemplate(model, template.content, ctx);
      } catch (err) {
        if (err instanceof TemplateProblems) {
          throw new RenderError(`Word template version ${template.version}: ${err.message}`);
        }
        throw err;
      }
    }
    return [{ filename: `${stem}.docx`, contentType: DOCX_TYPE, data }];
  },
};

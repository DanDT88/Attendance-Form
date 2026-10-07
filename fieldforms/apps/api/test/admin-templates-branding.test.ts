import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, fakeJpeg, H, login, type TestContext } from './helpers.js';

let t: TestContext;
let admin: string;
let manager: string;
let supervisor: string;

function patch(cookie: string, payload: object, id = t.fx.companyId) {
  return t.app.inject({
    method: 'PATCH',
    url: `/api/admin/companies/${id}`,
    headers: { ...H, cookie },
    payload,
  });
}

async function blob(data: Buffer, cookie = admin) {
  const id = randomUUID();
  const r = await t.app.inject({
    method: 'PUT',
    url: `/api/blobs/${id}`,
    headers: { ...H, cookie, 'content-type': 'application/octet-stream' },
    payload: data,
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return id;
}

const company = () =>
  t.owner
    .selectFrom('companies')
    .select(['name', 'brand_colour', 'logo_blob_id', 'document_footer'])
    .where('id', '=', t.fx.companyId)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  t = await createTestContext();
  admin = await login(t.app, 'admin@acme.test');
  manager = await login(t.app, 'manager@acme.test');
  supervisor = await login(t.app, 'S001');
});
afterAll(async () => t?.close());

describe('company branding', () => {
  it('sets and clears the colour, logo and document footer', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#1b365d' },
    })
      .png()
      .toBuffer();
    const logo = await blob(png);
    const r = await patch(admin, {
      brandColour: '#0A7E3F',
      logoBlobId: logo,
      documentFooter: '  Acme Cleaning (Pty) Ltd · Reg. 2001/000001/07  ',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      brand_colour: '#0A7E3F',
      logo_blob_id: logo,
      document_footer: 'Acme Cleaning (Pty) Ltd · Reg. 2001/000001/07',
    });
    expect(await company()).toMatchObject({ name: 'Acme Cleaning', brand_colour: '#0A7E3F' });

    // Other fields are left alone; an empty footer and null values clear them.
    const cleared = await patch(admin, { logoBlobId: null, documentFooter: '' });
    expect(cleared.statusCode).toBe(200);
    expect(await company()).toEqual({
      name: 'Acme Cleaning',
      brand_colour: '#0A7E3F',
      logo_blob_id: null,
      document_footer: null,
    });
    expect((await patch(admin, { brandColour: null })).statusCode).toBe(200);
    expect((await company()).brand_colour).toBeNull();

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/admin/companies',
      headers: { cookie: admin },
    });
    expect(list.json()[0]).toHaveProperty('brand_colour');
  });

  it('validates the colour (#RRGGBB), the logo and the footer length', async () => {
    for (const colour of ['green', '#0A7E3', '#0A7E3FF', '0A7E3F', '#GGGGGG'])
      expect((await patch(admin, { brandColour: colour })).statusCode, colour).toBe(400);
    expect((await patch(admin, { logoBlobId: randomUUID() })).json().error).toBe(
      'Upload the logo first',
    );
    expect((await patch(admin, { logoBlobId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await patch(admin, { documentFooter: 'x'.repeat(501) })).statusCode).toBe(400);
    // A photo format the document renderers do not take as a logo.
    const webp = await blob(
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
        .webp()
        .toBuffer(),
    );
    expect((await patch(admin, { logoBlobId: webp })).json().error).toBe(
      'The logo must be a PNG or JPEG image',
    );
    const jpeg = await blob(fakeJpeg(7));
    expect((await patch(admin, { logoBlobId: jpeg })).statusCode).toBe(200);
  });

  it('is for admins only', async () => {
    for (const who of [manager, supervisor])
      expect((await patch(who, { brandColour: '#000000' })).statusCode).toBe(403);
    expect((await company()).brand_colour).not.toBe('#000000');
  });
});

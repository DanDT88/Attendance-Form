import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '@fieldforms/shared';
import type { Db } from '../db/index.js';

/** Settings are stored one key per row; anything missing falls back to the default. */
export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.selectFrom('settings').select(['key', 'value']).execute();
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function updateSettings(
  db: Db,
  patch: Partial<Settings>,
  userId: string,
): Promise<Settings> {
  const current = await getSettings(db);
  const next = settingsSchema.parse({ ...current, ...patch });
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    const value = JSON.stringify(next[key]);
    await db
      .insertInto('settings')
      .values({ key, value, updated_by: userId })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({ value, updated_by: userId, updated_at: new Date() }),
      )
      .execute();
  }
  return next;
}

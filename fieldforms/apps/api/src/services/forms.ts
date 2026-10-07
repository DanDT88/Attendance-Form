import {
  formDefinition,
  validateDefinition,
  type DefinitionIssue,
  type FormDefinition,
  type Option,
} from '@fieldforms/shared';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { audit, type AuditContext } from './audit.js';

/** A new form starts with one field so its draft is valid and can be published straight away. */
export function starterDefinition(title: string): FormDefinition {
  return {
    schemaVersion: 1,
    title,
    settings: { siteRequired: true },
    fields: [{ id: 'notes', type: 'text', label: 'Notes', multiline: true }],
  };
}

async function listIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectFrom('option_lists')
    .select('id')
    .where('archived_at', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.id));
}

function nameTaken(err: unknown, what: string): never {
  if ((err as { code?: string }).code === '23505')
    throw conflict(`A ${what} with that name already exists`);
  throw err;
}

export async function listForms(db: Db) {
  return db
    .selectFrom('forms as f')
    .select([
      'f.id',
      'f.name',
      'f.archived_at',
      'f.draft_updated_at',
      'f.created_at',
      sql<number | null>`(SELECT max(v.version) FROM form_versions v WHERE v.form_id = f.id)`.as(
        'latest_version',
      ),
      sql<Date | null>`(SELECT max(v.published_at) FROM form_versions v WHERE v.form_id = f.id)`.as(
        'published_at',
      ),
      sql<number>`(SELECT count(*) FROM form_submissions s WHERE s.form_id = f.id)`.as(
        'submissions',
      ),
    ])
    .orderBy('f.name')
    .execute();
}

export async function createForm(
  db: Db,
  userId: string,
  name: string,
  definition: unknown,
  ctx: AuditContext,
) {
  const def = definition ?? starterDefinition(name);
  const id = await db
    .insertInto('forms')
    .values({
      name,
      draft_definition: JSON.stringify(def),
      draft_updated_by: userId,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
    .then((r) => r.id)
    .catch((e) => nameTaken(e, 'form'));
  await audit(db, ctx, { action: 'form.create', entity: 'form', entityId: id, details: { name } });
  return { id };
}

export async function getFormForEditing(db: Db, id: string) {
  const form = await db.selectFrom('forms').selectAll().where('id', '=', id).executeTakeFirst();
  if (!form) throw notFound('Form not found');
  const versions = await db
    .selectFrom('form_versions as v')
    .leftJoin('users as u', 'u.id', 'v.published_by')
    .select(['v.id', 'v.version', 'v.published_at', 'u.display_name as published_by'])
    .where('v.form_id', '=', id)
    .orderBy('v.version', 'desc')
    .execute();
  const check = validateDefinition(form.draft_definition, { listIds: await listIds(db) });
  return {
    form: {
      id: form.id,
      name: form.name,
      archived_at: form.archived_at,
      draft_updated_at: form.draft_updated_at,
    },
    draft: form.draft_definition,
    issues: check.issues,
    versions,
  };
}

/** Saves a draft even when it has issues (work in progress); returns them for the builder. */
export async function saveDraft(
  db: Db,
  userId: string,
  id: string,
  definition: unknown,
  ctx: AuditContext,
) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw badRequest('The definition must be a JSON object');
  }
  const res = await db
    .updateTable('forms')
    .set({
      draft_definition: JSON.stringify(definition),
      draft_updated_at: new Date(),
      draft_updated_by: userId,
    })
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  if (!res) throw notFound('Form not found');
  await audit(db, ctx, { action: 'form.draft_save', entity: 'form', entityId: id });
  return { issues: validateDefinition(definition, { listIds: await listIds(db) }).issues };
}

/**
 * Publishes the draft as the next version. Published versions never change (database trigger),
 * so this is the only way a form's behaviour changes, and old submissions keep their version.
 */
export async function publish(db: Db, userId: string, id: string, ctx: AuditContext) {
  return db.transaction().execute(async (trx) => {
    // Serialise publishes of the same form so two admins cannot both take the same number.
    const form = await trx
      .selectFrom('forms')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!form) throw notFound('Form not found');
    if (form.archived_at) throw badRequest('Unarchive the form before publishing');
    const check = validateDefinition(form.draft_definition, { listIds: await listIds(trx) });
    if (!check.ok)
      throw new HttpError(400, 'The form has problems to fix before publishing', check.issues);
    const last = await trx
      .selectFrom('form_versions')
      .select(({ fn }) => fn.max('version').as('v'))
      .where('form_id', '=', id)
      .executeTakeFirst();
    const version = (last?.v ?? 0) + 1;
    const row = await trx
      .insertInto('form_versions')
      .values({
        form_id: id,
        version,
        definition: JSON.stringify(check.definition),
        published_by: userId,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    // The form's name follows the published title, so lists show what people see.
    if (check.definition.title !== form.name) {
      await trx
        .updateTable('forms')
        .set({ name: check.definition.title })
        .where('id', '=', id)
        .execute()
        .catch((e) => nameTaken(e, 'form'));
    }
    await audit(trx, ctx, {
      action: 'form.publish',
      entity: 'form',
      entityId: id,
      details: { version },
    });
    return row;
  });
}

export async function setArchived(db: Db, id: string, archived: boolean, ctx: AuditContext) {
  const res = await db
    .updateTable('forms')
    .set({ archived_at: archived ? new Date() : null })
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  if (!res) throw notFound('Form not found');
  await audit(db, ctx, {
    action: archived ? 'form.archive' : 'form.unarchive',
    entity: 'form',
    entityId: id,
  });
}

export async function getVersion(db: Db, versionId: string) {
  const v = await db
    .selectFrom('form_versions as v')
    .innerJoin('forms as f', 'f.id', 'v.form_id')
    .select(['v.id', 'v.form_id', 'v.version', 'v.definition', 'f.name', 'f.archived_at'])
    .where('v.id', '=', versionId)
    .executeTakeFirst();
  if (!v) throw notFound('Form version not found');
  return { ...v, definition: formDefinition.parse(v.definition) };
}

/** The latest published version of every active form: what people can fill in. */
export async function publishedForms(db: Db) {
  const rows = await sql<{
    form_id: string;
    name: string;
    version_id: string;
    version: number;
    definition: unknown;
  }>`
    SELECT DISTINCT ON (v.form_id) v.form_id, f.name, v.id AS version_id, v.version, v.definition
    FROM form_versions v JOIN forms f ON f.id = v.form_id
    WHERE f.archived_at IS NULL
    ORDER BY v.form_id, v.version DESC
  `.execute(db);
  return rows.rows
    .map((r) => ({ ...r, definition: r.definition as FormDefinition }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** List ids used by choice fields in these definitions. */
export function listsUsed(defs: FormDefinition[]): string[] {
  const ids = new Set<string>();
  const visit = (fields: FormDefinition['fields']) => {
    for (const f of fields) {
      if ((f.type === 'select' || f.type === 'multiselect') && f.options.source === 'list')
        ids.add(f.options.listId);
      if (f.type === 'group') visit(f.fields as FormDefinition['fields']);
    }
  };
  defs.forEach((d) => visit(d.fields));
  return [...ids];
}

export async function listItems(db: Db, ids: string[]): Promise<Record<string, Option[]>> {
  if (!ids.length) return {};
  const rows = await db
    .selectFrom('option_lists')
    .select(['id', 'items'])
    .where('id', 'in', ids)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.id, r.items as Option[]]));
}

// ------------------------------------------------------------ option lists

export const MAX_LIST_ITEMS = 5_000;

function checkItems(items: Option[]): Option[] {
  if (items.length > MAX_LIST_ITEMS)
    throw badRequest(`A list can have at most ${MAX_LIST_ITEMS} items`);
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.value)) throw badRequest(`The value "${it.value}" appears twice`);
    seen.add(it.value);
  }
  return items;
}

/**
 * Reads "value,label" rows (label optional, header row optional, quotes allowed) into list items.
 * A one-column file uses each line as both value and label.
 */
export function parseCsvItems(text: string): Option[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const clean = rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
  if (clean.length && /^value$/i.test(clean[0]![0] ?? '')) clean.shift();
  return clean.map((r) => {
    const value = r[0]!.slice(0, 100);
    const label = (r[1] || r[0]!).slice(0, 200);
    if (!value) throw badRequest('Every row needs a value in the first column');
    return { value, label };
  });
}

export async function createList(
  db: Db,
  userId: string,
  name: string,
  items: Option[],
  ctx: AuditContext,
) {
  const id = await db
    .insertInto('option_lists')
    .values({ name, items: JSON.stringify(checkItems(items)), updated_by: userId })
    .returning('id')
    .executeTakeFirstOrThrow()
    .then((r) => r.id)
    .catch((e) => nameTaken(e, 'list'));
  await audit(db, ctx, {
    action: 'list.create',
    entity: 'option_list',
    entityId: id,
    details: { name, items: items.length },
  });
  return { id };
}

export async function updateList(
  db: Db,
  userId: string,
  id: string,
  patch: { name?: string; items?: Option[]; archived?: boolean },
  ctx: AuditContext,
) {
  const res = await db
    .updateTable('option_lists')
    .set({
      ...(patch.name && { name: patch.name }),
      ...(patch.items && { items: JSON.stringify(checkItems(patch.items)) }),
      ...(patch.archived !== undefined && { archived_at: patch.archived ? new Date() : null }),
      updated_at: new Date(),
      updated_by: userId,
    })
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst()
    .catch((e) => nameTaken(e, 'list'));
  if (!res) throw notFound('List not found');
  await audit(db, ctx, {
    action: 'list.update',
    entity: 'option_list',
    entityId: id,
    details: { name: patch.name, items: patch.items?.length, archived: patch.archived },
  });
}

// ------------------------------------------------------------ groups

export async function setGroup(
  db: Db,
  id: string | null,
  body: { name?: string; memberIds?: string[]; archived?: boolean },
  ctx: AuditContext,
): Promise<{ id: string }> {
  return db.transaction().execute(async (trx) => {
    let groupId = id;
    if (!groupId) {
      if (!body.name) throw badRequest('A group needs a name');
      groupId = await trx
        .insertInto('user_groups')
        .values({ name: body.name })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id)
        .catch((e) => nameTaken(e, 'group'));
    } else if (body.name || body.archived !== undefined) {
      const res = await trx
        .updateTable('user_groups')
        .set({
          ...(body.name && { name: body.name }),
          ...(body.archived !== undefined && { archived_at: body.archived ? new Date() : null }),
        })
        .where('id', '=', groupId)
        .returning('id')
        .executeTakeFirst()
        .catch((e) => nameTaken(e, 'group'));
      if (!res) throw notFound('Group not found');
    }
    if (body.memberIds) {
      const unique = [...new Set(body.memberIds)];
      if (unique.length) {
        const known = await trx
          .selectFrom('users')
          .select('id')
          .where('id', 'in', unique)
          .execute();
        if (known.length !== unique.length) throw badRequest('One or more users are unknown');
      }
      await trx.deleteFrom('user_group_members').where('group_id', '=', groupId).execute();
      if (unique.length) {
        await trx
          .insertInto('user_group_members')
          .values(unique.map((user_id) => ({ group_id: groupId!, user_id })))
          .execute();
      }
    }
    await audit(trx, ctx, {
      action: id ? 'group.update' : 'group.create',
      entity: 'user_group',
      entityId: groupId,
      details: { name: body.name, members: body.memberIds?.length, archived: body.archived },
    });
    return { id: groupId };
  });
}

export async function listGroups(db: Db) {
  const groups = await db.selectFrom('user_groups').selectAll().orderBy('name').execute();
  const members = await db.selectFrom('user_group_members').selectAll().execute();
  return groups.map((g) => ({
    ...g,
    memberIds: members.filter((m) => m.group_id === g.id).map((m) => m.user_id),
  }));
}

export type { DefinitionIssue };

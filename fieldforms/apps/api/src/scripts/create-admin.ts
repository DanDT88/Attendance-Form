import { hashSecret, validatePassword } from '../auth/passwords.js';
import { createDb } from '../db/index.js';
import { audit } from '../services/audit.js';

/**
 * Creates the first admin, or resets an existing admin's password and unlocks them.
 * Reads ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD from the environment so the password never
 * appears in shell history or the process list.
 */
const url = process.env.DATABASE_URL;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
const password = process.env.ADMIN_PASSWORD ?? '';
if (!url || !email || !password) {
  console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD (and optionally ADMIN_NAME).');
  process.exit(1);
}
const problem = validatePassword(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const { db } = createDb(url);
try {
  const passwordHash = await hashSecret(password);
  const existing = await db
    .selectFrom('users')
    .select(['id', 'role'])
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing && existing.role !== 'admin') {
    console.error(`${email} exists as a ${existing.role}; refusing to change it into an admin.`);
    process.exit(1);
  }
  const id = existing
    ? (
        await db
          .updateTable('users')
          .set({
            password_hash: passwordHash,
            active: true,
            failed_attempts: 0,
            locked_until: null,
          })
          .where('id', '=', existing.id)
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    : (
        await db
          .insertInto('users')
          .values({
            role: 'admin',
            display_name: name,
            email,
            employee_no: null,
            pin_hash: null,
            password_hash: passwordHash,
            oidc_issuer: null,
            oidc_subject: null,
            locked_until: null,
            last_login_at: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
  await audit(
    db,
    { actorUserId: null },
    {
      action: existing ? 'admin.user.password_reset_cli' : 'admin.user.create_cli',
      entity: 'user',
      entityId: id,
    },
  );
  console.log(`${existing ? 'Reset password for' : 'Created'} admin ${email}`);
} finally {
  await db.destroy();
}

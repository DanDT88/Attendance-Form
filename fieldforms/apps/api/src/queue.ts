import { CompiledQuery } from 'kysely';
import PgBoss from 'pg-boss';
import type { Db } from './db/index.js';
import type { JobQueue } from './services/registers.js';

export const REGISTER_NOTIFY = 'register-notify';
export const DISPATCH_NOTIFY = 'dispatch-notify';
/** Phase 3: work out a submission's deliveries; send one; run a check or test send. */
export const PLAN_DELIVERIES = 'plan-deliveries';
export const DELIVER = 'deliver';
export const DESTINATION_TEST = 'destination-test';

/**
 * The deliveries row owns retries and back-off (next_attempt_at), so a deliver job is never
 * retried by pg-boss; a job that outlives its expiry is picked up again by the sweeper through
 * the row's lease. Every adapter call has a deadline well inside both.
 */
export const DELIVER_JOB_OPTIONS = { retryLimit: 0, expireInSeconds: 600 } as const;
export const PLAN_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 300,
} as const;
export const TEST_JOB_OPTIONS = { retryLimit: 0, expireInSeconds: 300 } as const;

export const NOTIFY_JOB_OPTIONS = {
  retryLimit: 8,
  retryDelay: 30,
  retryBackoff: true,
  // Dead-letter after the retries: kept for inspection and redelivery rather than dropped.
  deadLetter: `${REGISTER_NOTIFY}-dead`,
} as const;

/**
 * Creates a queue unless it exists. The API and the worker both do this at start-up, and two
 * concurrent createQueue calls can deadlock inside pg-boss, so a deadlock or duplicate is retried.
 */
export async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Omit<PgBoss.Queue, 'name'> = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (await boss.getQueue(name)) return;
    try {
      await boss.createQueue(name, { name, ...options });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (attempt >= 5 || (code !== '40P01' && code !== '23505')) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt + Math.random() * 200));
    }
  }
}

export async function createBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();
  await ensureQueue(boss, `${REGISTER_NOTIFY}-dead`);
  await ensureQueue(boss, REGISTER_NOTIFY, NOTIFY_JOB_OPTIONS);
  await ensureQueue(boss, `${DISPATCH_NOTIFY}-dead`);
  await ensureQueue(boss, DISPATCH_NOTIFY, {
    ...NOTIFY_JOB_OPTIONS,
    deadLetter: `${DISPATCH_NOTIFY}-dead`,
  });
  await ensureQueue(boss, PLAN_DELIVERIES, PLAN_JOB_OPTIONS);
  await ensureQueue(boss, DELIVER, DELIVER_JOB_OPTIONS);
  await ensureQueue(boss, DESTINATION_TEST, TEST_JOB_OPTIONS);
  return boss;
}

/** pg-boss runs its insert on our transaction, so the job commits (or rolls back) with it. */
function inTransaction(trx: Db): PgBoss.Db {
  return {
    async executeSql(text, values) {
      const r = await trx.executeQuery(CompiledQuery.raw(text, values));
      return { rows: r.rows as unknown[] };
    },
  };
}

/** `send` returns null instead of throwing when the queue does not exist; never lose a job silently. */
async function sendOrThrow(boss: PgBoss, name: string, data: object, options: PgBoss.SendOptions) {
  const id = await boss.send(name, data, options);
  if (!id) throw new Error(`Could not enqueue ${name}: does the queue exist?`);
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async enqueuePlanDeliveries(submissionId, trx) {
      await sendOrThrow(
        boss,
        PLAN_DELIVERIES,
        { submissionId },
        { ...PLAN_JOB_OPTIONS, db: inTransaction(trx) },
      );
    },
    async enqueueDelivery(job, trx, startAfter) {
      await sendOrThrow(boss, DELIVER, job, {
        ...DELIVER_JOB_OPTIONS,
        db: inTransaction(trx),
        ...(startAfter ? { startAfter } : {}),
      });
    },
    async enqueueTest(testId, trx) {
      await sendOrThrow(
        boss,
        DESTINATION_TEST,
        { testId },
        { ...TEST_JOB_OPTIONS, db: inTransaction(trx) },
      );
    },
    async enqueueRegisterNotify(submissionId) {
      // singletonKey is not enforced on standard queues (pg-boss 10); the sweeper checks for a live
      // job instead (notify.ts liveJobClause) and delivery checks notification_log.
      await boss.send(
        REGISTER_NOTIFY,
        { submissionId },
        { ...NOTIFY_JOB_OPTIONS, singletonKey: submissionId },
      );
    },
    async enqueueDispatchNotify(dispatchId) {
      await boss.send(
        DISPATCH_NOTIFY,
        { dispatchId },
        { ...NOTIFY_JOB_OPTIONS, deadLetter: `${DISPATCH_NOTIFY}-dead`, singletonKey: dispatchId },
      );
    },
  };
}

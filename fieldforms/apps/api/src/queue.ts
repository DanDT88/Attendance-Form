import PgBoss from 'pg-boss';
import type { JobQueue } from './services/registers.js';

export const REGISTER_NOTIFY = 'register-notify';

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
  return boss;
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async enqueueRegisterNotify(submissionId) {
      // singletonKey: a second enqueue for the same register while one is queued is a no-op.
      await boss.send(
        REGISTER_NOTIFY,
        { submissionId },
        { ...NOTIFY_JOB_OPTIONS, singletonKey: submissionId },
      );
    },
  };
}

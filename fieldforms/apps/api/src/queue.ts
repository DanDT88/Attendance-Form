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

export async function createBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();
  await boss.createQueue(`${REGISTER_NOTIFY}-dead`);
  await boss.createQueue(REGISTER_NOTIFY, { name: REGISTER_NOTIFY, ...NOTIFY_JOB_OPTIONS });
  return boss;
}

export function bossQueue(boss: PgBoss): JobQueue {
  return {
    async enqueueRegisterNotify(submissionId) {
      // singletonKey: a second enqueue for the same register while one is queued is a no-op.
      await boss.send(REGISTER_NOTIFY, { submissionId }, { ...NOTIFY_JOB_OPTIONS, singletonKey: submissionId });
    },
  };
}

import nodemailer from 'nodemailer';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createBlobStore } from './lib/blobstore.js';
import { bossQueue, createBoss, ensureQueue, REGISTER_NOTIFY } from './queue.js';
import { deliverRegisterSummary, findUndelivered, gotenbergRenderer, type Mailer } from './services/notify.js';

/**
 * Background jobs: emails each start/end register summary (with PDF) to its site's recipients,
 * and a sweeper that re-enqueues anything the API failed to enqueue.
 */
const cfg = loadConfig();
const mailEnv = z
  .object({
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().default(1025),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().default('FieldForms <fieldforms@localhost>'),
    GOTENBERG_URL: z.string().url().optional(),
  })
  .parse(process.env);

const transport = nodemailer.createTransport({
  host: mailEnv.SMTP_HOST,
  port: mailEnv.SMTP_PORT,
  secure: mailEnv.SMTP_SECURE === 'true',
  auth: mailEnv.SMTP_USER ? { user: mailEnv.SMTP_USER, pass: mailEnv.SMTP_PASSWORD } : undefined,
});
const mailer: Mailer = {
  async send(msg) {
    await transport.sendMail({ from: mailEnv.MAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, attachments: msg.attachments });
  },
};

const { db } = createDb(cfg.DATABASE_URL);
const blobs = createBlobStore(cfg);
await blobs.ensureReady();
const pdf = gotenbergRenderer(mailEnv.GOTENBERG_URL);
const boss = await createBoss(cfg.DATABASE_URL);
const queue = bossQueue(boss);

await boss.work<{ submissionId: string }>(REGISTER_NOTIFY, async ([job]) => {
  if (!job) return;
  const outcome = await deliverRegisterSummary(db, blobs, mailer, pdf, job.data.submissionId);
  console.log(`[worker] ${REGISTER_NOTIFY} ${job.data.submissionId}: ${outcome}`);
});

const SWEEP = 'register-notify-sweep';
await ensureQueue(boss, SWEEP);
await boss.schedule(SWEEP, '*/10 * * * *');
await boss.work(SWEEP, async () => {
  const ids = await findUndelivered(db);
  for (const id of ids) await queue.enqueueRegisterNotify(id);
  if (ids.length) console.log(`[worker] sweep re-enqueued ${ids.length}`);
});

console.log('[worker] started');

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 20_000 });
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

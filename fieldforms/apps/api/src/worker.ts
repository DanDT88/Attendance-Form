import { hostname } from 'node:os';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { DEFAULT_ENDPOINTS, type Mailer as DestinationMailer } from './destinations/types.js';
import { createBlobStore } from './lib/blobstore.js';
import { parseNetworkPolicy } from './lib/netguard.js';
import { createSecretOpener } from './lib/secrets.js';
import { gotenbergConverter } from './outputs/gotenberg.js';
import {
  bossQueue,
  createBoss,
  DELIVER,
  DESTINATION_TEST,
  DISPATCH_NOTIFY,
  ensureQueue,
  PLAN_DELIVERIES,
  REGISTER_NOTIFY,
} from './queue.js';
import { planDeliveries, sweepDeliveries } from './services/deliveries.js';
import { runAlerts } from './services/delivery-alerts.js';
import { runDelivery, runTest, type DocumentsApi } from './services/delivery-runner.js';
import { dispatchRecipients } from './services/dispatch.js';
import * as documents from './services/documents.js';
import {
  deliverDispatchEmail,
  deliverRegisterSummary,
  findUndelivered,
  findUnnotifiedDispatches,
  gotenbergRenderer,
  type Mailer,
} from './services/notify.js';

/**
 * Background jobs: emails each start/end register summary (with PDF) to its site's recipients;
 * Phase 3 deliveries (planning, sending, checks and test sends); sweepers that re-enqueue
 * anything lost, and failure alerts.
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
    /** Refuse to send without STARTTLS (off only for a local mail catcher in development). */
    SMTP_REQUIRE_TLS: z.enum(['true', 'false']).default('true'),
  })
  .parse(process.env);

const transport = nodemailer.createTransport({
  host: mailEnv.SMTP_HOST,
  port: mailEnv.SMTP_PORT,
  secure: mailEnv.SMTP_SECURE === 'true',
  requireTLS: mailEnv.SMTP_SECURE !== 'true' && mailEnv.SMTP_REQUIRE_TLS === 'true',
  auth: mailEnv.SMTP_USER ? { user: mailEnv.SMTP_USER, pass: mailEnv.SMTP_PASSWORD } : undefined,
});
const mailer: Mailer = {
  async send(msg) {
    await transport.sendMail({
      from: mailEnv.MAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      attachments: msg.attachments,
    });
  },
};

/** The same transport for destinations, which need the message id and the server's reply. */
const destinationMailer: DestinationMailer = {
  async send(msg) {
    const info = await transport.sendMail({
      from: mailEnv.MAIL_FROM,
      to: msg.to,
      cc: msg.cc,
      replyTo: msg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments,
      headers: msg.headers,
    });
    return { messageId: info.messageId, response: info.response };
  },
};

const { db } = createDb(cfg.DATABASE_URL);
const blobs = createBlobStore(cfg);
await blobs.ensureReady();
const pdf = gotenbergRenderer(cfg.GOTENBERG_URL);
const boss = await createBoss(cfg.DATABASE_URL);
const queue = bossQueue(boss);

await boss.work<{ submissionId: string }>(REGISTER_NOTIFY, async ([job]) => {
  if (!job) return;
  const outcome = await deliverRegisterSummary(db, blobs, mailer, pdf, job.data.submissionId);
  console.log(`[worker] ${REGISTER_NOTIFY} ${job.data.submissionId}: ${outcome}`);
});

await boss.work<{ dispatchId: string }>(DISPATCH_NOTIFY, async ([job]) => {
  if (!job) return;
  const outcome = await deliverDispatchEmail(
    db,
    mailer,
    job.data.dispatchId,
    cfg.PUBLIC_URL,
    (id) => dispatchRecipients(db, id),
  );
  console.log(`[worker] ${DISPATCH_NOTIFY} ${job.data.dispatchId}: ${outcome}`);
});

// ---- Phase 3: deliveries

const policy = parseNetworkPolicy(cfg);
const pipeline = {
  db,
  queue,
  blobs,
  opener: createSecretOpener(cfg.SECRETS_PRIVATE_KEY, cfg.SECRETS_PRIVATE_KEY_PREVIOUS),
  pdf: gotenbergConverter({
    url: cfg.GOTENBERG_URL,
    username: cfg.GOTENBERG_USERNAME,
    password: cfg.GOTENBERG_PASSWORD,
  }),
  mailer: destinationMailer,
  publicUrl: cfg.PUBLIC_URL,
  policy,
  // Vendors (Google, Microsoft, Slack) are always public: never the private ranges.
  vendorPolicy: parseNetworkPolicy({}),
  endpoints: DEFAULT_ENDPOINTS,
  emailAttachmentLimit: cfg.EMAIL_ATTACHMENT_LIMIT_MB * 1024 * 1024,
  worker: `${hostname()}:${process.pid}`,
  documents: documents as unknown as DocumentsApi,
};

await boss.work<{ submissionId: string }>(PLAN_DELIVERIES, async ([job]) => {
  if (!job) return;
  const outcome = await planDeliveries(db, queue, job.data.submissionId);
  console.log(`[worker] ${PLAN_DELIVERIES} ${job.data.submissionId}: ${outcome}`);
});

// Several loops, so one slow destination does not hold up the rest (pg-boss runs one job at a
// time per registration). Each job is one attempt; the deliveries row decides about retries.
for (let i = 0; i < cfg.DELIVERY_CONCURRENCY; i++) {
  await boss.work<{ deliveryId: string; generation: number }>(DELIVER, async ([job]) => {
    if (!job) return;
    const outcome = await runDelivery(pipeline, { ...job.data, jobId: job.id });
    if (outcome !== 'not-claimed')
      console.log(`[worker] ${DELIVER} ${job.data.deliveryId}: ${outcome}`);
  });
}

await boss.work<{ testId: string }>(DESTINATION_TEST, async ([job]) => {
  if (!job) return;
  const outcome = await runTest(pipeline, job.data.testId);
  console.log(`[worker] ${DESTINATION_TEST} ${job.data.testId}: ${outcome}`);
});

const DELIVERY_SWEEP = 'deliveries-sweep';
await ensureQueue(boss, DELIVERY_SWEEP);
await boss.schedule(DELIVERY_SWEEP, '*/2 * * * *');
await boss.work(DELIVERY_SWEEP, async () => {
  const r = await sweepDeliveries(db, queue);
  if (r.planned + r.requeued + r.abandoned) console.log(`[worker] deliveries sweep`, r);
});

const ALERTS = 'delivery-alerts';
await ensureQueue(boss, ALERTS);
await boss.schedule(ALERTS, '*/5 * * * *');
await boss.work(ALERTS, async () => {
  const r = await runAlerts(db, destinationMailer, cfg.PUBLIC_URL);
  if (r.sent) console.log(`[worker] alerts sent: ${r.sent}`);
});

const SWEEP = 'register-notify-sweep';
await ensureQueue(boss, SWEEP);
await boss.schedule(SWEEP, '*/10 * * * *');
await boss.work(SWEEP, async () => {
  const ids = await findUndelivered(db);
  for (const id of ids) await queue.enqueueRegisterNotify(id);
  const tasks = await findUnnotifiedDispatches(db);
  for (const id of tasks) await queue.enqueueDispatchNotify(id);
  if (ids.length + tasks.length)
    console.log(`[worker] sweep re-enqueued ${ids.length} registers, ${tasks.length} tasks`);
});

console.log('[worker] started');

const shutdown = async () => {
  await boss.stop({ graceful: true, timeout: 20_000 });
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

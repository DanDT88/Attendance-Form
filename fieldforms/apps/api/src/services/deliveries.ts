import type { Db } from '../db/index.js';
import type { JobQueue } from './registers.js';

/**
 * The delivery pipeline (ARCHITECTURE.md, "Delivery pipeline"): planning, claiming and finishing
 * attempts, the sweeper, incidents and alerts, resend, retry and backfill. Built in the main
 * checkout; the functions below are what the admin API calls.
 */

/**
 * Cancels a destination's pending deliveries (it was deactivated or archived), with a
 * `cancelled` attempt each. Runs in the caller's transaction. Returns how many.
 */
export async function cancelPendingDeliveries(
  _trx: Db,
  _destinationId: string,
  _by: string | null,
  _reason: string,
): Promise<number> {
  throw new Error('cancelPendingDeliveries is not built yet');
}

/**
 * Creates missing deliveries of a destination for the given submissions (backfill, or "also
 * send submissions since …" when a destination is created or re-activated) and enqueues them in
 * the caller's transaction. Existing deliveries are left alone. Conditions are evaluated unless
 * `ignoreCondition`. Returns counts.
 */
export async function backfillDeliveries(
  _trx: Db,
  _queue: JobQueue,
  _input: {
    destinationId: string;
    submissionIds: string[];
    triggeredBy: string;
    ignoreCondition: boolean;
  },
): Promise<{ created: number; skipped: number; existing: number }> {
  throw new Error('backfillDeliveries is not built yet');
}

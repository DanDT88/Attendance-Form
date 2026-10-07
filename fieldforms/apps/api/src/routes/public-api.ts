import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

/**
 * The public REST API at /api/v1: registered beside the /api scope, not inside it, so it never
 * reads session cookies or needs the CSRF header. Authenticates `Authorization: Bearer` API keys.
 */
export async function publicApiRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}

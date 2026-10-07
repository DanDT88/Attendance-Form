import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request as the fakes see it. */
export interface FakeRequest {
  method: string;
  /** Path as sent (still percent-encoded). */
  path: string;
  /** Raw query string without "?". */
  rawQuery: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export interface FakeReply {
  status: number;
  json?: unknown;
  body?: Buffer | string;
  headers?: Record<string, string>;
}

/**
 * Failures to inject: answer `status` instead of handling the request (`lost: false`), or
 * handle it and then answer `status` (`lost: true`, a reply lost after the work was done).
 */
export interface Failure {
  match: (r: FakeRequest) => boolean;
  status: number;
  json?: unknown;
  lost?: boolean;
  times?: number;
}

/** A local HTTP server that routes every request to `handle`, with failure injection and a log. */
export class FakeServer {
  url = '';
  log: FakeRequest[] = [];
  failures: Failure[] = [];
  /** Runs before each request is handled (to simulate another client acting at that moment). */
  before?: (r: FakeRequest) => void;
  private server: Server;

  constructor(private handle: (r: FakeRequest) => FakeReply | Promise<FakeReply>) {
    this.server = createServer((req, res) => void this.serve(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }

  /** Fails the next matching request(s). */
  fail(f: Failure): void {
    this.failures.push({ times: 1, ...f });
  }

  private take(r: FakeRequest, lost: boolean): Failure | undefined {
    const f = this.failures.find((x) => !!x.lost === lost && (x.times ?? 1) > 0 && x.match(r));
    if (f) f.times = (f.times ?? 1) - 1;
    return f;
  }

  private async serve(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const r: FakeRequest = {
      method: req.method ?? 'GET',
      path: q < 0 ? raw : raw.slice(0, q),
      rawQuery: q < 0 ? '' : raw.slice(q + 1),
      query: new URLSearchParams(q < 0 ? '' : raw.slice(q + 1)),
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    this.log.push(r);
    this.before?.(r);
    let reply: FakeReply;
    const early = this.take(r, false);
    if (early) reply = { status: early.status, json: early.json ?? {} };
    else {
      try {
        reply = await this.handle(r);
      } catch (err) {
        reply = { status: 500, json: { error: { message: String(err) } } };
      }
      const lost = this.take(r, true);
      if (lost) reply = { status: lost.status, json: lost.json ?? {} };
    }
    const headers: Record<string, string> = { ...reply.headers };
    let body: Buffer | string = reply.body ?? '';
    if (reply.json !== undefined) {
      body = JSON.stringify(reply.json);
      headers['content-type'] = 'application/json';
    }
    res.writeHead(reply.status, headers);
    res.end(body);
  }
}

export const json = (status: number, body: unknown): FakeReply => ({ status, json: body });

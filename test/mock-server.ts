/**
 * A small scripted HTTP server for the unit tests: each route answers from a
 * queue of canned responses (the last one repeats) and every request is
 * recorded, so tests can assert on paths, queries, headers and bodies.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface CannedResponse {
  status?: number;
  body?: unknown;
  /** Sent as-is instead of JSON. */
  raw?: string;
  headers?: Record<string, string>;
  /** Wait before answering (ms). */
  delayMs?: number;
  /** Drop the connection without answering. */
  destroy?: boolean;
}

export type Handler = CannedResponse | ((req: RecordedRequest) => CannedResponse);

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  on(method: string, path: string, ...handlers: Handler[]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Handler[]>();
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const queue = routes.get(`${recorded.method} ${recorded.path}`);
      const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      const canned: CannedResponse = !handler
        ? { status: 404, body: { error: 'NOT_FOUND', message: `No mock for ${recorded.method} ${recorded.path}` } }
        : typeof handler === 'function'
          ? handler(recorded)
          : handler;
      const send = () => {
        if (canned.destroy) {
          req.socket.destroy();
          return;
        }
        const status = canned.status ?? 200;
        const headers: Record<string, string> = { ...canned.headers };
        let payload = '';
        if (canned.raw !== undefined) payload = canned.raw;
        else if (canned.body !== undefined) {
          payload = JSON.stringify(canned.body);
          headers['content-type'] ??= 'application/json';
        }
        res.writeHead(status, headers);
        res.end(payload);
      };
      if (canned.delayMs) setTimeout(send, canned.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, ...handlers) {
      routes.set(`${method} /v1${path}`, handlers);
    },
    reset() {
      routes.clear();
      requests.length = 0;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A clock and sleep that move instantly, recording every delay. */
export function fakeTime(start = 1_700_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(Math.round(ms));
      now += ms;
    },
    /** Jitter factor 1 (no randomness): `random()` returns 1. */
    random: () => 1,
  };
}

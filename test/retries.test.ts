import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  Client,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '../src/index.js';
import { design, renderResult } from './fixtures.js';
import { fakeTime, startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;

before(async () => {
  server = await startMockServer();
});
afterEach(() => server.reset());
after(() => server.close());

function makeClient(extra: Partial<ConstructorParameters<typeof Client>[0]> = {}) {
  const time = fakeTime();
  const client = new Client({ apiKey: 'k', baseUrl: server.url, sleep: time.sleep, now: time.now, random: time.random, ...extra });
  return { client, time };
}
const designsPage = { body: { designs: [design], pagination: { nextCursor: null, hasMore: false } } };
const renderOk = { body: { data: renderResult } };
const err = (status: number, error: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, message: `${error} message`, ...extra } });

describe('error mapping', () => {
  const cases: Array<[number, string, new (...a: any[]) => APIError]> = [
    [400, 'VALIDATION_ERROR', BadRequestError],
    [401, 'INVALID_API_KEY', AuthenticationError],
    [402, 'QUOTA_EXCEEDED', PaymentRequiredError],
    [403, 'ORG_ON_HOLD', PermissionDeniedError],
    [404, 'NOT_FOUND', NotFoundError],
    [409, 'CONFLICT', ConflictError],
    [422, 'VALIDATION_ERROR', UnprocessableEntityError],
    [500, 'INTERNAL', InternalServerError],
  ];
  for (const [status, code, cls] of cases) {
    it(`${status} → ${cls.name}`, async () => {
      const { client } = makeClient({ maxRetries: 0 });
      server.on('POST', '/render', err(status, code, { detail: { remaining: 1 } }));
      const e = await client.render({ templateId: 't' }).catch((x) => x);
      assert.ok(e instanceof cls, `got ${e?.constructor?.name}`);
      assert.ok(e instanceof APIError);
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.equal(e.error, code);
      assert.equal(e.message, `${code} message`);
      assert.deepEqual(e.detail, { remaining: 1 });
    });
  }

  it('wraps a non-JSON error body', async () => {
    const { client } = makeClient({ maxRetries: 0 });
    server.on('GET', '/designs', { status: 502, raw: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } });
    const e = await client.designs.list().catch((x) => x);
    assert.ok(e instanceof InternalServerError);
    assert.equal(e.code, 'HTTP_502');
    assert.match(e.message, /HTTP 502: <html>Bad gateway/);
  });

  it('reads Retry-After into RateLimitError.retryAfter', async () => {
    const { client } = makeClient({ maxRetries: 0 });
    server.on('GET', '/designs', { ...err(429, 'RATE_LIMITED', { detail: { retryAfter: 30 } }), headers: { 'retry-after': '12' } });
    const e = await client.designs.list().catch((x) => x);
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.retryAfter, 12);
  });

  it('falls back to detail.retryAfter', async () => {
    const { client } = makeClient({ maxRetries: 0 });
    server.on('GET', '/designs', err(429, 'RATE_LIMITED', { detail: { retryAfter: 7 } }));
    const e = await client.designs.list().catch((x) => x);
    assert.equal(e.retryAfter, 7);
  });
});

describe('retries', () => {
  it('retries a 429 even on POST /render, honouring Retry-After', async () => {
    const { client, time } = makeClient();
    server.on('POST', '/render', { ...err(429, 'RATE_LIMITED'), headers: { 'retry-after': '2' } }, renderOk);
    const out = await client.render({ templateId: 't' });
    assert.equal(out.data.renderId, 'ren_1');
    assert.equal(server.requests.length, 2);
    assert.deepEqual(time.sleeps, [2000]);
  });

  it('uses backoff when a 429 has no Retry-After', async () => {
    const { client, time } = makeClient();
    server.on('GET', '/designs', err(429, 'RATE_LIMITED'), err(429, 'RATE_LIMITED'), designsPage);
    await client.designs.list();
    assert.deepEqual(time.sleeps, [500, 1000]);
  });

  it('gives up on a 429 whose Retry-After is longer than maxRetryDelayMs', async () => {
    const { client, time } = makeClient({ maxRetryDelayMs: 10_000 });
    server.on('GET', '/designs', { ...err(429, 'RATE_LIMITED'), headers: { 'retry-after': '30' } }, designsPage);
    const e = await client.designs.list().catch((x) => x);
    assert.ok(e instanceof RateLimitError);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(time.sleeps, []);
  });

  it('retries a 503 on GET with exponential backoff', async () => {
    const { client, time } = makeClient();
    server.on('GET', '/designs', err(503, 'INTERNAL'), err(502, 'INTERNAL'), designsPage);
    const res = await client.designs.list();
    assert.equal(res.designs.length, 1);
    assert.equal(server.requests.length, 3);
    assert.deepEqual(time.sleeps, [500, 1000]);
  });

  it('applies jitter between half and the full delay', async () => {
    const { client, time } = makeClient({ random: () => 0 });
    server.on('GET', '/designs', err(503, 'INTERNAL'), designsPage);
    await client.designs.list();
    assert.deepEqual(time.sleeps, [250]);
  });

  it('throws the last error once retries run out', async () => {
    const { client } = makeClient({ maxRetries: 2 });
    server.on('GET', '/designs', err(500, 'INTERNAL'));
    const e = await client.designs.list().catch((x) => x);
    assert.ok(e instanceof InternalServerError);
    assert.equal(server.requests.length, 3);
  });

  it('never retries a 5xx on POST /render (it may have been charged)', async () => {
    const { client, time } = makeClient();
    server.on('POST', '/render', err(500, 'INTERNAL'), renderOk);
    const e = await client.render({ templateId: 't' }).catch((x) => x);
    assert.ok(e instanceof InternalServerError);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(time.sleeps, []);
  });

  for (const [method, path, call] of [
    ['POST', '/social/posts', (c: Client) => c.social.posts.create({ renderId: 'r' })],
    ['POST', '/social/posts/p/cancel', (c: Client) => c.social.posts.cancel('p')],
    ['POST', '/signed-urls/rotate-key', (c: Client) => c.signedUrls.rotateKey()],
    ['POST', '/webhooks/subscriptions', (c: Client) => c.webhooks.subscriptions.create({ url: 'https://x', events: ['design.created'] })],
  ] as const) {
    it(`does not retry a 503 on ${method} ${path}`, async () => {
      const { client } = makeClient();
      server.on(method, path, err(503, 'INTERNAL'));
      await assert.rejects(call(client), InternalServerError);
      assert.equal(server.requests.length, 1);
    });
  }

  it('retries a 5xx on the side-effect-free POSTs (auth, signed URLs)', async () => {
    const { client } = makeClient();
    server.on('POST', '/auth', err(503, 'INTERNAL'), { body: { username: 'x' } });
    assert.equal((await client.whoami()).username, 'x');
    server.on('POST', '/signed-urls', err(503, 'INTERNAL'), { body: { data: { url: 'u', templateId: 't', format: 'png', expiresAt: '' } } });
    assert.equal((await client.signedUrls.create({ templateId: 't' })).data.url, 'u');
  });

  it('retries a dropped connection on GET but not on POST /render', async () => {
    const { client } = makeClient();
    server.on('GET', '/designs', { destroy: true }, designsPage);
    assert.equal((await client.designs.list()).designs.length, 1);
    server.reset();
    server.on('POST', '/render', { destroy: true }, renderOk);
    const e = await client.render({ templateId: 't' }).catch((x) => x);
    assert.ok(e instanceof APIConnectionError);
    assert.equal(server.requests.length, 1);
  });

  it('times out slow requests', async () => {
    const client = new Client({ apiKey: 'k', baseUrl: server.url, timeoutMs: 50, maxRetries: 0 });
    server.on('GET', '/designs', { ...designsPage, delayMs: 500 });
    const e = await client.designs.list().catch((x) => x);
    assert.ok(e instanceof APITimeoutError);
    assert.ok(e instanceof APIConnectionError);
  });

  it('honours an AbortSignal without retrying', async () => {
    const client = new Client({ apiKey: 'k', baseUrl: server.url });
    server.on('GET', '/designs', { ...designsPage, delayMs: 500 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await assert.rejects(client.designs.list({}, { signal: controller.signal }), /stop/);
    assert.equal(server.requests.length, 1);
  });

  it('lets a call override maxRetries', async () => {
    const { client } = makeClient({ maxRetries: 5 });
    server.on('GET', '/designs', err(500, 'INTERNAL'));
    await assert.rejects(client.designs.list({}, { maxRetries: 0 }), InternalServerError);
    assert.equal(server.requests.length, 1);
  });
});

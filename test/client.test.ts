import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, describe, it } from 'node:test';
import { BRAND, Client, NotFoundError, JamFrame, SDKError, VERSION, fileUrls, normalizeBaseUrl } from '../src/index.js';
import { design, designDetail, post } from './fixtures.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
let client: Client;

before(async () => {
  server = await startMockServer();
  client = new Client({ apiKey: 'jf_live_test', baseUrl: server.url, maxRetries: 0 });
});
afterEach(() => server.reset());
after(() => server.close());

const last = () => server.requests.at(-1)!;
const page = <T>(items: T[], nextCursor: string | null = null) => ({
  pagination: { nextCursor, hasMore: nextCursor !== null },
  items,
});

describe('client setup', () => {
  it('normalises the base URL to the API root', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com/v1');
    assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com/v1');
    assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(normalizeBaseUrl('http://localhost:3100'), 'http://localhost:3100/v1');
    // The older address keeps working as given.
    assert.equal(normalizeBaseUrl('https://app.example.com/api/v1/'), 'https://app.example.com/api/v1');
    assert.throws(() => normalizeBaseUrl('ftp://x'), SDKError);
    assert.throws(() => normalizeBaseUrl('not a url'), SDKError);
  });

  it('defaults to production and reads the environment', () => {
    const saved = { key: process.env[BRAND.apiKeyEnv], url: process.env[BRAND.baseUrlEnv] };
    try {
      delete process.env[BRAND.apiKeyEnv];
      delete process.env[BRAND.baseUrlEnv];
      assert.throws(() => new Client(), /No API key/);
      process.env[BRAND.apiKeyEnv] = 'jf_live_env';
      assert.equal(new Client().baseUrl, `${BRAND.defaultBaseUrl}/v1`);
      process.env[BRAND.baseUrlEnv] = 'http://localhost:3100';
      assert.equal(new Client().baseUrl, 'http://localhost:3100/v1');
    } finally {
      if (saved.key === undefined) delete process.env[BRAND.apiKeyEnv];
      else process.env[BRAND.apiKeyEnv] = saved.key;
      if (saved.url === undefined) delete process.env[BRAND.baseUrlEnv];
      else process.env[BRAND.baseUrlEnv] = saved.url;
    }
  });

  it('sends the bearer key, Accept and a User-Agent', async () => {
    server.on('POST', '/auth', { body: { workspaceId: 'ws_1', username: 'Jane' } });
    const custom = new Client({ apiKey: 'jf_live_test', baseUrl: server.url, userAgent: 'my-app/2.0' });
    assert.deepEqual(await custom.whoami(), { workspaceId: 'ws_1', username: 'Jane' });
    const { headers } = last();
    assert.equal(headers.authorization, 'Bearer jf_live_test');
    assert.equal(headers.accept, 'application/json');
    assert.match(String(headers['user-agent']), new RegExp(`^my-app/2\\.0 ${BRAND.userAgentPrefix}/${VERSION.replace(/\./g, '\\.')} node/`));
  });

  it('exports the client under the product name too', () => {
    assert.equal(JamFrame, Client);
  });

  it('keeps VERSION equal to package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});

describe('designs', () => {
  it('lists with source, q, cursor and limit', async () => {
    server.on('GET', '/designs', { body: { designs: [{ ...design, animated: true }], pagination: { nextCursor: null, hasMore: false } } });
    const res = await client.designs.list({ source: 'library', q: 'promo reel', cursor: 'c1', limit: 50 });
    assert.equal(res.designs[0]!.id, 'tpl_1');
    assert.equal(res.designs[0]!.pages, 3);
    assert.equal(res.designs[0]!.animated, true);
    assert.equal(last().query.get('source'), 'library');
    assert.equal(last().query.get('q'), 'promo reel');
    assert.equal(last().query.get('cursor'), 'c1');
    assert.equal(last().query.get('limit'), '50');
  });

  it('omits unset query parameters', async () => {
    server.on('GET', '/designs', { body: { designs: [], pagination: { nextCursor: null, hasMore: false } } });
    await client.designs.list();
    assert.equal([...last().query.keys()].length, 0);
  });

  it('iterates across pages', async () => {
    server.on('GET', '/designs', (req) => {
      const cursor = req.query.get('cursor');
      const p = cursor === null ? page([{ ...design, id: 'a' }, { ...design, id: 'b' }], 'b') : page([{ ...design, id: 'c' }]);
      return { body: { designs: p.items, pagination: p.pagination } };
    });
    const ids: string[] = [];
    for await (const d of client.designs.iterate({ source: 'library', q: 'coffee', limit: 2 })) ids.push(d.id);
    assert.deepEqual(ids, ['a', 'b', 'c']);
    assert.deepEqual(
      server.requests.map((r) => [r.query.get('cursor'), r.query.get('source'), r.query.get('q'), r.query.get('limit')]),
      [
        [null, 'library', 'coffee', '2'],
        ['b', 'library', 'coffee', '2'],
      ],
    );
  });

  it('gets one design (unwrapped) and encodes the id', async () => {
    server.on('GET', '/designs/a%20b', { body: { design: designDetail } });
    const d = await client.designs.get('a b');
    assert.equal(d.pages, 3);
    assert.equal(d.sizes[0]!.id, 'story');
    assert.equal(last().path, '/v1/designs/a%20b');
  });
});

describe('renders log', () => {
  it('lists with filters and iterates', async () => {
    const item = { id: 'ren_1', createdAt: '', designId: 'tpl_1', designName: 'x', source: 'api', format: 'png', pages: 1, credits: 1, status: 'succeeded', durationMs: 10, outputs: [], error: null, cached: false };
    const totals = { periodStart: '', periodEnd: '', creditsUsed: 1, creditsQuota: 100, creditsRemaining: 99, workspaceCreditsUsed: 1 };
    server.on(
      'GET',
      '/renders',
      { body: { renders: [item], pagination: { nextCursor: 'ren_1', hasMore: true }, totals } },
      { body: { renders: [{ ...item, id: 'ren_2' }], pagination: { nextCursor: null, hasMore: false }, totals } },
    );
    const first = await client.renders.list({ status: 'succeeded', designId: 'tpl_1', limit: 1 });
    assert.equal(first.totals.creditsRemaining, 99);
    assert.equal(last().query.get('status'), 'succeeded');
    assert.equal(last().query.get('designId'), 'tpl_1');
    const ids: string[] = [];
    for await (const r of client.renders.iterate({ status: 'succeeded' })) ids.push(r.id);
    assert.deepEqual(ids, ['ren_2']);
  });

  it('gets one render (unwrapped) and encodes the id', async () => {
    const item = { id: 'ren 1', createdAt: '', designId: 'tpl_1', designName: 'x', source: 'api', format: 'png', pages: 1, credits: 1, status: 'succeeded', durationMs: 10, outputs: [{ url: 'https://cdn.example.com/r/1.png', page: 1 }], error: null, cached: false };
    server.on('GET', '/renders/ren%201', { body: { render: item } });
    const render = await client.renders.get('ren 1');
    assert.equal(render.outputs[0]!.url, 'https://cdn.example.com/r/1.png');
    assert.equal(last().path, '/v1/renders/ren%201');
  });

  it('turns a 404 into a NotFoundError', async () => {
    server.on('GET', '/renders/nope', { status: 404, body: { error: 'NOT_FOUND', message: 'Render nope not found in this workspace' } });
    await assert.rejects(client.renders.get('nope'), NotFoundError);
  });
});

describe('signed URLs', () => {
  it('creates and rotates', async () => {
    server.on('POST', '/signed-urls', (req) => ({
      body: { data: { url: 'https://app.example.com/r/s/x.png', templateId: req.body.templateId, format: 'png', expiresAt: '2026-12-01T00:00:00.000Z' } },
    }));
    const signed = await client.signedUrls.create({ templateId: 'tpl_1', modifications: { title: 'Hi' }, expiresIn: 60 });
    assert.equal(signed.data.templateId, 'tpl_1');
    assert.deepEqual(last().body, { templateId: 'tpl_1', modifications: { title: 'Hi' }, expiresIn: 60 });
    server.on('POST', '/signed-urls/rotate-key', { body: { data: { rotatedAt: '2026-11-09T15:20:00.000Z' } } });
    assert.deepEqual(await client.signedUrls.rotateKey(), { rotatedAt: '2026-11-09T15:20:00.000Z' });
  });
});

describe('social', () => {
  it('lists accounts', async () => {
    server.on('GET', '/social/accounts', { body: { accounts: [{ id: 'acc_1', platform: 'x', platformName: 'X', name: 'acme', status: 'active', sandbox: true, createdAt: '' }] } });
    const accounts = await client.social.accounts.list();
    assert.equal(accounts[0]!.sandbox, true);
  });

  it('creates, lists, gets, cancels and retries posts', async () => {
    server.on('POST', '/social/posts', { status: 201, body: { post, checks: [] } });
    const created = await client.social.posts.create({ renderId: 'ren_1', accounts: ['acc_1'], caption: 'Spring sale', scheduledAt: '2026-11-10T09:00', timezone: 'Europe/Paris' });
    assert.equal(created.post.id, 'post_1');
    assert.deepEqual(last().body, { renderId: 'ren_1', accounts: ['acc_1'], caption: 'Spring sale', scheduledAt: '2026-11-10T09:00', timezone: 'Europe/Paris' });

    server.on('GET', '/social/posts', { body: { posts: [post], pagination: { nextCursor: null, hasMore: false } } });
    const list = await client.social.posts.list({ status: 'queue', limit: 10 });
    assert.equal(list.posts.length, 1);
    assert.equal(last().query.get('status'), 'queue');
    const all = [];
    for await (const p of client.social.posts.iterate()) all.push(p);
    assert.equal(all.length, 1);

    server.on('GET', '/social/posts/post_1', { body: { post } });
    assert.equal((await client.social.posts.get('post_1')).targets[0]!.platform, 'linkedin');

    server.on('POST', '/social/posts/post_1/cancel', { body: { post: { ...post, status: 'canceled' } } });
    assert.equal((await client.social.posts.cancel('post_1')).status, 'canceled');

    server.on('POST', '/social/posts/post_1/retry', { body: { post } });
    await client.social.posts.retry('post_1', { targetId: 'tgt_1' });
    assert.deepEqual(last().body, { targetId: 'tgt_1' });
    await client.social.posts.retry('post_1');
    assert.deepEqual(last().body, {});
  });
});

describe('webhook subscriptions', () => {
  const sub = { id: 'sub_1', url: 'https://example.com/h', events: ['render.completed'], status: 'active', secretTail: 'wxyz', failureCount: 0, lastFiredAt: null, createdAt: '', updatedAt: '' };

  it('covers every endpoint', async () => {
    server.on('POST', '/webhooks/subscriptions', { status: 201, body: { subscription: sub, signingSecret: 'wh_sec_1' } });
    const created = await client.webhooks.subscriptions.create({ url: 'https://example.com/h', events: ['render.completed'] });
    assert.equal(created.signingSecret, 'wh_sec_1');
    assert.deepEqual(last().body, { url: 'https://example.com/h', events: ['render.completed'] });

    server.on('GET', '/webhooks/subscriptions', { body: { subscriptions: [sub], pagination: { nextCursor: null, hasMore: false } } });
    assert.equal((await client.webhooks.subscriptions.list({ limit: 5 })).subscriptions.length, 1);
    const ids = [];
    for await (const s of client.webhooks.subscriptions.iterate()) ids.push(s.id);
    assert.deepEqual(ids, ['sub_1']);

    server.on('GET', '/webhooks/subscriptions/sub_1', { body: { subscription: sub } });
    assert.equal((await client.webhooks.subscriptions.get('sub_1')).secretTail, 'wxyz');

    server.on('POST', '/webhooks/subscriptions/sub_1/test', { status: 202, body: { delivery: { id: 'd1', eventType: 'render.completed', createdAt: '' }, sample: { id: 'whe_1', type: 'render.completed', createdAt: '', data: {} } } });
    assert.equal((await client.webhooks.subscriptions.test('sub_1', 'render.completed')).delivery.id, 'd1');
    assert.deepEqual(last().body, { eventType: 'render.completed' });

    server.on('POST', '/webhooks/subscriptions/sub_1/rotate-secret', { body: { subscription: sub, signingSecret: 'wh_sec_2' } });
    assert.equal((await client.webhooks.subscriptions.rotateSecret('sub_1')).signingSecret, 'wh_sec_2');

    server.on('DELETE', '/webhooks/subscriptions/sub_1', { status: 204 });
    assert.equal(await client.webhooks.subscriptions.delete('sub_1'), undefined);
    assert.equal(last().method, 'DELETE');
  });
});

describe('fileUrls', () => {
  it('flattens every content shape', () => {
    assert.deepEqual(fileUrls('a'), ['a']);
    assert.deepEqual(fileUrls(['a', 'b']), ['a', 'b']);
    assert.deepEqual(
      fileUrls([
        { size: 'story', name: 'Story', width: 1, height: 1, pages: [1], url: 's1' },
        { size: 'square', name: 'Square', width: 1, height: 1, pages: [1, 2], urls: ['q1', 'q2'] },
      ]),
      ['s1', 'q1', 'q2'],
    );
  });
});

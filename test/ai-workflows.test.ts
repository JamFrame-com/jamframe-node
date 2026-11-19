import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { Client, ConflictError, DesignJobFailedError, WaitTimeoutError } from '../src/index.js';
import type { DesignGenerateJob, WorkflowRun } from '../src/index.js';
import { designDetail } from './fixtures.js';
import { fakeTime, startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
let client: Client;
let time: ReturnType<typeof fakeTime>;

before(async () => {
  server = await startMockServer();
});
afterEach(() => server.reset());
after(() => server.close());

function makeClient() {
  time = fakeTime();
  client = new Client({ apiKey: 'jf_live_test', baseUrl: server.url, maxRetries: 0, sleep: time.sleep, now: time.now });
  return client;
}

const last = () => server.requests.at(-1)!;

const designJob = (overrides: Partial<DesignGenerateJob> = {}): DesignGenerateJob => ({
  jobId: 'dj_1',
  status: 'running',
  createdAt: '2026-11-19T10:00:00.000Z',
  finishedAt: null,
  ...overrides,
});
const generated = { ...designDetail, editorUrl: 'https://app.example.com/designs/tpl_1/edit' };

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run_1',
  workflowId: 'wf_1',
  trigger: 'api',
  status: 'queued',
  rowsTotal: 0,
  rowsSucceeded: 0,
  rowsFailed: 0,
  rowsSkipped: 0,
  credits: 0,
  warnings: [],
  createdAt: '2026-11-19T10:00:00.000Z',
  ...overrides,
});

describe('render options', () => {
  it('sends expiresIn, translate, lang and ai as given', async () => {
    makeClient();
    server.on('POST', '/render', { body: { data: { content: 'u', type: 'url', format: 'png', pages: [1], credits: 1, renderId: 'r', responseTime: 1 } } });
    await client.render({
      templateId: 'tool-quote-card-paper',
      expiresIn: 3600,
      translate: true,
      lang: 'es',
      ai: { onError: 'fallback' },
      response: { format: 'pdf', cmyk: { profile: 'gracol2013' }, compress: true },
    });
    assert.deepEqual(last().body, {
      templateId: 'tool-quote-card-paper',
      expiresIn: 3600,
      translate: true,
      lang: 'es',
      ai: { onError: 'fallback' },
      response: { format: 'pdf', cmyk: { profile: 'gracol2013' }, compress: true },
    });
  });
});

describe('designs.generate', () => {
  it('returns the design when the API answers 201', async () => {
    makeClient();
    server.on('POST', '/designs/generate', { status: 201, body: { data: designJob({ status: 'succeeded', design: generated, creditsCharged: 15 }) } });
    const job = await client.designs.generate({ prompt: 'A summer sale post', size: 'instagram-portrait' });
    assert.equal(job.design.id, 'tpl_1');
    assert.deepEqual(last().body, { prompt: 'A summer sale post', size: 'instagram-portrait' });
  });

  it('polls the job when the API answers 202', async () => {
    makeClient();
    server.on('POST', '/designs/generate', { status: 202, body: { data: { jobId: 'dj_1', status: 'running' } } });
    server.on(
      'GET',
      '/designs/generate/dj_1',
      { body: { data: designJob() } },
      { body: { data: designJob({ status: 'succeeded', design: generated }) } },
    );
    const job = await client.designs.generate({ prompt: 'p' });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(time.sleeps, [1000]);
  });

  it('throws DesignJobFailedError with the job error code', async () => {
    makeClient();
    server.on('POST', '/designs/generate', { status: 202, body: { data: { jobId: 'dj_1', status: 'running' } } });
    server.on('GET', '/designs/generate/dj_1', {
      body: { data: designJob({ status: 'failed', error: { error: 'AI_BAD_OUTPUT', message: 'No design' } }) },
    });
    await assert.rejects(client.designs.generate({ prompt: 'p' }), (err: unknown) => {
      assert.ok(err instanceof DesignJobFailedError);
      assert.equal(err.code, 'AI_BAD_OUTPUT');
      assert.equal(err.message, 'No design');
      return true;
    });
  });

  it('generateAsync sends async and webhookUrl and returns the job id', async () => {
    makeClient();
    server.on('POST', '/designs/generate', { status: 202, body: { data: { jobId: 'dj_9', status: 'running' } } });
    const accepted = await client.designs.generateAsync({ prompt: 'p', webhookUrl: 'https://example.com/hook' });
    assert.deepEqual(accepted, { jobId: 'dj_9', status: 'running' });
    assert.deepEqual(last().body, { prompt: 'p', webhookUrl: 'https://example.com/hook', async: true });
  });

  it('designJobs.wait gives up after timeoutMs', async () => {
    makeClient();
    server.on('GET', '/designs/generate/dj_1', { body: { data: designJob() } });
    await assert.rejects(client.designJobs.wait('dj_1', { timeoutMs: 3000 }), (err: unknown) => {
      assert.ok(err instanceof WaitTimeoutError);
      assert.match(err.message, /^Design generation dj_1 did not finish within 3 s/);
      assert.equal(err.lastJob?.status, 'running');
      return true;
    });
  });
});

describe('workflows', () => {
  it('lists, gets, creates, updates and deletes', async () => {
    makeClient();
    const wf = { id: 'wf_1', name: 'Quote cards' };
    server.on('GET', '/workflows', { body: { workflows: [wf] } });
    server.on('GET', '/workflows/wf_1', { body: { workflow: wf } });
    server.on('POST', '/workflows', { status: 201, body: { workflow: wf } });
    server.on('PATCH', '/workflows/wf_1', { body: { workflow: { ...wf, status: 'active' } } });
    server.on('DELETE', '/workflows/wf_1', { status: 204 });

    assert.deepEqual(await client.workflows.list(), [wf]);
    assert.deepEqual(await client.workflows.get('wf_1'), wf);
    await client.workflows.create({ starter: 'csv-quotes-webhook' });
    assert.deepEqual(last().body, { starter: 'csv-quotes-webhook' });
    assert.equal((await client.workflows.update('wf_1', { status: 'active' })).status, 'active');
    assert.deepEqual(last().body, { status: 'active' });
    await client.workflows.delete('wf_1');
    assert.equal(last().method, 'DELETE');
  });

  it('runAndWait queues a run and polls it until it ends', async () => {
    makeClient();
    server.on('POST', '/workflows/wf_1/run', { status: 202, body: { run: run() } });
    server.on(
      'GET',
      '/workflows/wf_1/runs/run_1',
      { body: { run: { ...run({ status: 'running' }), rows: [] } } },
      { body: { run: { ...run({ status: 'partial', rowsTotal: 2, rowsSucceeded: 1, rowsFailed: 1 }), rows: [] } } },
    );
    const seen: string[] = [];
    const done = await client.workflows.runAndWait('wf_1', { maxRows: 2 }, { onProgress: (r) => seen.push(r.status) });
    assert.equal(done.status, 'partial');
    assert.deepEqual(seen, ['running', 'partial']);
    assert.deepEqual(server.requests[0]!.body, { maxRows: 2 });
  });

  it('pages runs, cancels a run and rotates the webhook URL', async () => {
    makeClient();
    server.on(
      'GET',
      '/workflows/wf_1/runs',
      { body: { runs: [run()], pagination: { nextCursor: 'c2', hasMore: true } } },
      { body: { runs: [run({ id: 'run_2' })], pagination: { nextCursor: null, hasMore: false } } },
    );
    const ids: string[] = [];
    for await (const r of client.workflows.runs.iterate('wf_1', { limit: 1 })) ids.push(r.id);
    assert.deepEqual(ids, ['run_1', 'run_2']);
    assert.equal(last().query.get('cursor'), 'c2');

    server.on('POST', '/workflows/wf_1/runs/run_1/cancel', { status: 409, body: { error: 'CONFLICT', message: 'Finished' } });
    await assert.rejects(client.workflows.runs.cancel('wf_1', 'run_1'), ConflictError);

    server.on('POST', '/workflows/wf_1/webhook-token', { body: { webhookUrl: 'https://api.example.com/hooks/new' } });
    assert.equal(await client.workflows.rotateWebhookUrl('wf_1'), 'https://api.example.com/hooks/new');
  });
});

describe('social analytics', () => {
  it('joins platform and account lists with commas', async () => {
    makeClient();
    server.on('GET', '/social/analytics/overview', { body: { postsPublished: 3 } });
    await client.social.analytics.overview({ from: '2026-11-01', to: '2026-11-19', platform: ['instagram', 'x'], accountId: 'acc_1' });
    const { query } = last();
    assert.equal(query.get('from'), '2026-11-01');
    assert.equal(query.get('to'), '2026-11-19');
    assert.equal(query.get('platform'), 'instagram,x');
    assert.equal(query.get('accountId'), 'acc_1');
  });

  it('reads daily and insights', async () => {
    makeClient();
    server.on('GET', '/social/analytics/daily', { body: { days: [] } });
    server.on('GET', '/social/analytics/insights', { body: { topPosts: [] } });
    assert.deepEqual(await client.social.analytics.daily(), { days: [] });
    assert.deepEqual(await client.social.analytics.insights(), { topPosts: [] });
  });
});

describe('ai', () => {
  it('status', async () => {
    makeClient();
    server.on('GET', '/ai/status', { body: { status: 'live' } });
    assert.equal((await client.ai.status()).status, 'live');
  });

  it('removeBackground from a URL sends JSON', async () => {
    makeClient();
    server.on('POST', '/images/remove-background', { body: { url: 'https://cdn.example.com/cut.png' } });
    await client.ai.removeBackground({ url: 'https://example.com/shot.jpg', name: 'Product' });
    assert.deepEqual(last().body, { url: 'https://example.com/shot.jpg', name: 'Product' });
    assert.match(String(last().headers['content-type']), /application\/json/);
  });

  it('removeBackground from a file uploads it as multipart', async () => {
    makeClient();
    server.on('POST', '/images/remove-background', { body: { url: 'https://cdn.example.com/cut.png' } });
    await client.ai.removeBackground({ file: Buffer.from('PNGDATA'), filename: 'shot.png', name: 'Product' });
    const { headers, body } = last();
    assert.match(String(headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.match(body, /name="file"; filename="shot.png"/);
    assert.match(body, /PNGDATA/);
    assert.match(body, /name="name"\r\n\r\nProduct/);
  });

  it('transcribe sends its options with a URL or a file', async () => {
    makeClient();
    server.on('POST', '/ai/transcribe', { body: { text: 'Hello' } });
    await client.ai.transcribe({ url: 'https://example.com/a.mp3', style: 'short', offset: 3, words: true });
    assert.deepEqual(last().body, { url: 'https://example.com/a.mp3', style: 'short', offset: 3, words: true });

    await client.ai.transcribe({ file: new Blob(['MP3DATA']), filename: 'a.mp3', offset: 3, words: true });
    const { body } = last();
    assert.match(body, /filename="a.mp3"/);
    assert.match(body, /name="offset"\r\n\r\n3/);
    assert.match(body, /name="words"\r\n\r\ntrue/);
  });
});

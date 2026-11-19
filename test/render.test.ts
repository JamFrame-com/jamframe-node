import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { Client, RenderJobFailedError, SDKError, WaitTimeoutError, type RenderJob } from '../src/index.js';
import { job, renderResult } from './fixtures.js';
import { fakeTime, startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;

before(async () => {
  server = await startMockServer();
});
afterEach(() => server.reset());
after(() => server.close());

function makeClient() {
  const time = fakeTime();
  const client = new Client({ apiKey: 'k', baseUrl: server.url, sleep: time.sleep, now: time.now, random: time.random });
  return { client, time };
}
const accepted = { status: 202, body: { data: { jobId: 'job_1', status: 'queued' } }, headers: { location: '/v1/render-jobs/job_1' } };
const succeeded = job({ status: 'succeeded', progress: 1, result: { ...renderResult, format: 'mp4', content: 'https://cdn/v.mp4', duration: 13 }, warnings: ['Unknown modification keys: titel'] });

describe('render()', () => {
  it('returns the synchronous result with warnings (always an array)', async () => {
    const { client } = makeClient();
    server.on('POST', '/render', { body: { data: renderResult } });
    const out = await client.render({
      templateId: 'tpl_1',
      modifications: { title: 'Hi', 'page2@title.color': '#FF0000', 'audio.volume': 0.5, badge: null },
      response: { format: 'png', size: 'story', scale: 2 },
    });
    assert.deepEqual(out, { data: renderResult, warnings: [] });
    assert.deepEqual(server.requests[0]!.body, {
      templateId: 'tpl_1',
      modifications: { title: 'Hi', 'page2@title.color': '#FF0000', 'audio.volume': 0.5, badge: null },
      response: { format: 'png', size: 'story', scale: 2 },
    });
    assert.equal(server.requests[0]!.headers['content-type'], 'application/json');
  });

  it('passes warnings and Smart Resize sizes through', async () => {
    const { client } = makeClient();
    const sized = { ...renderResult, content: [{ size: 'story', name: 'Story', width: 1080, height: 1920, pages: [1], url: 'u1' }], credits: 1 };
    server.on('POST', '/render', { body: { data: sized, warnings: ['w'] } });
    const out = await client.render({ templateId: 't', response: { sizes: ['story'] } });
    assert.deepEqual(out.warnings, ['w']);
    assert.equal((out.data.content as any)[0].url, 'u1');
  });

  it('never sends async, even if a caller slips it in', async () => {
    const { client } = makeClient();
    server.on('POST', '/render', { body: { data: renderResult } });
    await client.render({ templateId: 't', async: true } as any);
    assert.equal('async' in server.requests[0]!.body, false);
  });

  it('waits for the job when an MP4 comes back 202', async () => {
    const { client, time } = makeClient();
    server.on('POST', '/render', accepted);
    server.on('GET', '/render-jobs/job_1', { body: { job: job({ status: 'running', progress: 0.5 }) } }, { body: { job: succeeded } });
    const seen: number[] = [];
    const out = await client.render(
      { templateId: 't', response: { format: 'mp4' }, webhookUrl: 'https://hooks.example.com/x' },
      { onProgress: (j) => seen.push(j.progress) },
    );
    assert.equal(out.data.content, 'https://cdn/v.mp4');
    assert.equal(out.data.duration, 13);
    assert.deepEqual(out.warnings, ['Unknown modification keys: titel']);
    assert.deepEqual(seen, [0.5, 1]);
    assert.deepEqual(time.sleeps, [1000]);
    assert.equal(server.requests[0]!.body.webhookUrl, 'https://hooks.example.com/x');
  });
});

describe('renderAsync() and renderAndWait()', () => {
  it('sends async: true and returns the job id', async () => {
    const { client } = makeClient();
    server.on('POST', '/render', accepted);
    assert.deepEqual(await client.renderAsync({ templateId: 't', webhookUrl: 'https://h.example.com' }), { jobId: 'job_1', status: 'queued' });
    assert.deepEqual(server.requests[0]!.body, { templateId: 't', webhookUrl: 'https://h.example.com', async: true });
  });

  it('complains if the API does not hand back a job', async () => {
    const { client } = makeClient();
    server.on('POST', '/render', { body: { data: renderResult } });
    await assert.rejects(client.renderAsync({ templateId: 't' }), SDKError);
  });

  it('polls with backoff (1 s ×1.5, capped at 5 s) until the job succeeds', async () => {
    const { client, time } = makeClient();
    server.on('POST', '/render', accepted);
    const running = { body: { job: job({ status: 'running', progress: 0.2 }) } };
    server.on('GET', '/render-jobs/job_1', running, running, running, running, running, running, { body: { job: succeeded } });
    const done = await client.renderAndWait({ templateId: 't', response: { format: 'mp4' } });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.duration, 13);
    assert.deepEqual(time.sleeps, [1000, 1500, 2250, 3375, 5000, 5000]);
  });

  it('throws RenderJobFailedError with the job error', async () => {
    const { client } = makeClient();
    server.on('POST', '/render', accepted);
    server.on('GET', '/render-jobs/job_1', {
      body: { job: job({ status: 'failed', error: { error: 'VALIDATION_ERROR', message: 'Video failed to load' } }) },
    });
    const e = await client.renderAndWait({ templateId: 't' }).catch((x) => x);
    assert.ok(e instanceof RenderJobFailedError);
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.equal(e.message, 'Video failed to load');
    assert.equal(e.job.id, 'job_1');
  });

  it('throws WaitTimeoutError after timeoutMs with the last job seen', async () => {
    const { client, time } = makeClient();
    server.on('POST', '/render', accepted);
    server.on('GET', '/render-jobs/job_1', { body: { job: job({ status: 'running', progress: 0.3 }) } });
    const e = await client.renderAndWait({ templateId: 't' }, { timeoutMs: 4000 }).catch((x) => x);
    assert.ok(e instanceof WaitTimeoutError);
    assert.equal(e.jobId, 'job_1');
    assert.equal((e.lastJob as RenderJob).progress, 0.3);
    // 1000 + 1500 = 2500, then the remaining 1500 instead of 2250.
    assert.deepEqual(time.sleeps, [1000, 1500, 1500]);
  });
});

describe('renderJobs', () => {
  it('gets a job (unwrapped)', async () => {
    const { client } = makeClient();
    server.on('GET', '/render-jobs/job_1', { body: { job: succeeded } });
    const j = await client.renderJobs.get('job_1');
    assert.equal(j.result?.renderId, 'ren_1');
  });

  it('waits on an existing job with a custom first interval', async () => {
    const { client, time } = makeClient();
    server.on('GET', '/render-jobs/job_9', { body: { job: job({ id: 'job_9', status: 'queued' }) } }, { body: { job: { ...succeeded, id: 'job_9' } } });
    const done = await client.renderJobs.wait('job_9', { pollIntervalMs: 2000 });
    assert.equal(done.id, 'job_9');
    assert.deepEqual(time.sleeps, [2000]);
  });
});

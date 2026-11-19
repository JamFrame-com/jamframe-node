/**
 * Live smoke test against a running API. Skipped unless
 * JAMFRAME_SMOKE_API_KEY is set; JAMFRAME_SMOKE_BASE_URL defaults to the
 * local dev API. Spends 2 credits (two one-page PNG renders of a library
 * template). Run: `JAMFRAME_SMOKE_API_KEY=jf_live_… npm run test:smoke`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRAND, Client, NotFoundError, fileUrls, type Design, type DesignDetail } from '../src/index.js';

const apiKey = process.env[BRAND.smokeApiKeyEnv];
const baseUrl = process.env[BRAND.smokeBaseUrlEnv] ?? 'http://localhost:3100';

describe('live smoke', { skip: apiKey ? false : `set ${BRAND.smokeApiKeyEnv} to run` }, () => {
  const client = new Client({ apiKey: apiKey ?? 'unused', baseUrl });
  let template: DesignDetail | undefined;
  let renderId: string | undefined;

  it('authenticates', async () => {
    const me = await client.whoami();
    assert.ok(me.username);
  });

  it('lists workspace designs and iterates the library', async () => {
    const page = await client.designs.list({ limit: 5 });
    assert.ok(Array.isArray(page.designs));
    const library: Design[] = [];
    for await (const d of client.designs.iterate({ source: 'library', limit: 20 })) library.push(d);
    assert.ok(library.length > 0, 'the template library is empty');
    // A one-page still template: not animated, no video, audio or subtitles.
    for (const d of library) {
      if (d.animated || d.pages !== 1) continue;
      const detail = await client.designs.get(d.id);
      if (!detail.parameters.some((p) => ['video', 'audio', 'subtitles'].includes(p.type))) {
        template = detail;
        break;
      }
    }
    assert.ok(template, 'no one-page still template in the library');
    // The name search finds it, ignoring case.
    const found = await client.designs.list({ source: 'library', q: template.name.toUpperCase(), limit: 100 });
    assert.ok(found.designs.some((d) => d.id === template!.id), 'q did not find the template by name');
  });

  it('renders a PNG synchronously (1 credit)', async () => {
    assert.ok(template);
    const text = template.parameters.find((p) => p.type === 'text' || p.type === 'variable');
    const out = await client.render({
      templateId: template.id,
      modifications: text ? { [text.key]: 'SDK smoke test' } : {},
      response: { format: 'png' },
    });
    assert.equal(out.data.format, 'png');
    assert.equal(out.data.credits, 1);
    const [url] = fileUrls(out.data.content);
    assert.match(url ?? '', /^https?:\/\/.+\.png/);
    renderId = out.data.renderId;
  });

  it('renders as a job and waits for it (1 credit)', async () => {
    assert.ok(template);
    const progress: string[] = [];
    const job = await client.renderAndWait(
      { templateId: template.id, response: { format: 'png' } },
      { timeoutMs: 120_000, onProgress: (j) => progress.push(j.status) },
    );
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.credits, 1);
    assert.ok(progress.at(-1) === 'succeeded');
  });

  it('finds the render in the log', async () => {
    const page = await client.renders.list({ limit: 10, designId: template?.id });
    assert.ok(page.renders.some((r) => r.id === renderId), 'render not in the log');
    assert.ok(typeof page.totals.creditsUsed === 'number');
    const one = await client.renders.get(renderId!);
    assert.equal(one.id, renderId);
    assert.equal(one.status, 'succeeded');
  });

  it('signs a URL (free: nothing renders until it is opened)', async () => {
    assert.ok(template);
    const signed = await client.signedUrls.create({ templateId: template.id, response: { format: 'png' }, expiresIn: 300 });
    assert.match(signed.data.url, /\/r\/s\/.+\.png$/);
  });

  it('lists social accounts and posts to a sandbox account if there is one', async (t) => {
    const accounts = await client.social.accounts.list();
    const sandbox = accounts.find((a) => a.sandbox && a.status === 'active');
    await client.social.posts.list({ limit: 5 });
    if (!sandbox || !renderId) {
      t.skip('no active sandbox social account in this workspace');
      return;
    }
    const created = await client.social.posts.create({
      renderId,
      accounts: [sandbox.id],
      caption: 'SDK smoke test (sandbox)',
    });
    let post = created.post;
    for (let i = 0; i < 30 && !['published', 'partial', 'failed', 'canceled'].includes(post.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      post = await client.social.posts.get(post.id);
    }
    assert.equal(post.status, 'published');
  });

  it('reads AI status, workflows and social analytics (free)', async () => {
    const ai = await client.ai.status();
    assert.ok(['live', 'mock', 'off'].includes(ai.status));
    assert.equal(typeof ai.credits.used, 'number');
    const workflows = await client.workflows.list();
    assert.ok(Array.isArray(workflows));
    if (workflows[0]) await client.workflows.runs.list(workflows[0].id, { limit: 1 });
    const overview = await client.social.analytics.overview();
    assert.ok(overview.range.days > 0);
    const daily = await client.social.analytics.daily({ platform: ['instagram', 'linkedin'] });
    assert.equal(daily.days.length, daily.range.days);
    await client.social.analytics.insights();
  });

  it('creates, reads and deletes a webhook subscription', async () => {
    const created = await client.webhooks.subscriptions.create({
      url: 'https://example.com/jamframe-sdk-smoke',
      events: ['design.deleted'],
    });
    try {
      assert.match(created.signingSecret, /^wh_sec_/);
      const sub = await client.webhooks.subscriptions.get(created.subscription.id);
      assert.deepEqual(sub.events, ['design.deleted']);
    } finally {
      await client.webhooks.subscriptions.delete(created.subscription.id);
    }
    await assert.rejects(client.webhooks.subscriptions.get(created.subscription.id), NotFoundError);
  });
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  Client,
  WebhookSignatureError,
  constructWebhookEvent,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/index.js';

const secret = 'wh_sec_AbCdEfGh01234567890abcdefghijKLMN';
const t = 1_762_700_000;
const body = JSON.stringify({
  id: 'whe_1',
  type: 'render.completed',
  createdAt: '2026-11-09T12:38:50.201Z',
  data: { id: 'job_1', status: 'succeeded', result: { content: 'https://cdn/v.mp4' } },
});
// Computed the way the API reference ("Outbound webhooks") describes the server's signature.
const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const header = `t=${t},v1=${v1}`;

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature (string and bytes payloads)', () => {
    assert.equal(verifyWebhookSignature(body, header, secret, { now: t + 10 }), true);
    assert.equal(verifyWebhookSignature(Buffer.from(body), header, secret, { now: t }), true);
    assert.equal(verifyWebhookSignature(new TextEncoder().encode(body), header, secret, { now: t }), true);
  });

  it('matches signWebhookPayload', () => {
    assert.equal(signWebhookPayload(body, secret, t), header);
  });

  it('rejects a changed body, a wrong secret and a stale or future timestamp', () => {
    assert.equal(verifyWebhookSignature(body.replace('succeeded', 'failed'), header, secret, { now: t }), false);
    assert.equal(verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 2), header, secret, { now: t }), false);
    assert.equal(verifyWebhookSignature(body, header, 'wh_sec_other', { now: t }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { now: t + 301 }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { now: t - 301 }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { now: t + 1000, toleranceSeconds: 2000 }), true);
  });

  it('rejects malformed or missing headers', () => {
    for (const bad of ['', 'garbage', `t=${t}`, `v1=${v1}`, `t=abc,v1=${v1}`, `t=${t},v1=xyz`, undefined, null]) {
      assert.equal(verifyWebhookSignature(body, bad as any, secret, { now: t }), false, String(bad));
    }
  });

  it('accepts any of several secrets (rotation) and any of several v1 values', () => {
    assert.equal(verifyWebhookSignature(body, header, ['wh_sec_new', secret], { now: t }), true);
    assert.equal(verifyWebhookSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${v1}`, secret, { now: t }), true);
    assert.equal(verifyWebhookSignature(body, header, [], { now: t }), false);
  });

  it('reads the header from Headers, Node headers and plain objects', () => {
    assert.equal(verifyWebhookSignature(body, new Headers({ 'X-Webhook-Signature': header }), secret, { now: t }), true);
    assert.equal(verifyWebhookSignature(body, { 'x-webhook-signature': header, host: 'x' }, secret, { now: t }), true);
    assert.equal(verifyWebhookSignature(body, { 'X-Webhook-Signature': [header] }, secret, { now: t }), true);
    assert.equal(verifyWebhookSignature(body, {}, secret, { now: t }), false);
  });

  it('refuses a stale delivery when the tolerance is NaN (fails closed)', () => {
    const stale = signWebhookPayload(body, secret, t - 3600);
    assert.equal(verifyWebhookSignature(body, stale, secret, { now: t, toleranceSeconds: NaN }), false);
    assert.equal(verifyWebhookSignature(body, header, secret, { now: NaN }), false);
  });

  it('treats a missing secret as no secret, and refuses an oversized timestamp', () => {
    assert.equal(verifyWebhookSignature(body, header, undefined as any, { now: t }), false);
    assert.equal(verifyWebhookSignature(body, header, [undefined, ''] as any, { now: t }), false);
    assert.equal(verifyWebhookSignature(body, `t=${'9'.repeat(400)},v1=${v1}`, secret, { now: t }), false);
  });

  it('throws (rather than returning false) when given parsed JSON instead of the raw body', () => {
    assert.throws(() => verifyWebhookSignature(JSON.parse(body), header, secret, { now: t }), TypeError);
    assert.throws(() => constructWebhookEvent(JSON.parse(body), header, secret, { now: t }), /raw request body/);
  });

  it('uses the real clock by default', () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifyWebhookSignature(body, signWebhookPayload(body, secret), secret), true);
    assert.equal(verifyWebhookSignature(body, signWebhookPayload(body, secret, now - 3600), secret), false);
  });
});

describe('constructWebhookEvent', () => {
  it('returns the typed event', () => {
    const event = constructWebhookEvent(body, header, secret, { now: t });
    assert.equal(event.type, 'render.completed');
    if (event.type === 'render.completed') assert.equal(event.data.id, 'job_1');
  });

  it('throws WebhookSignatureError with a reason', () => {
    assert.throws(() => constructWebhookEvent(body, header, 'nope', { now: t }), WebhookSignatureError);
    assert.throws(() => constructWebhookEvent(body, header, secret, { now: t + 999 }), /tolerance/);
    const notJson = 'hello';
    assert.throws(() => constructWebhookEvent(notJson, signWebhookPayload(notJson, secret, t), secret, { now: t }), /not JSON/);
    const notEvent = '{"a":1}';
    assert.throws(() => constructWebhookEvent(notEvent, signWebhookPayload(notEvent, secret, t), secret, { now: t }), /not an event/);
  });

  it('is also on client.webhooks', () => {
    const client = new Client({ apiKey: 'k', baseUrl: 'http://localhost:1' });
    assert.equal(client.webhooks.verifySignature(body, header, secret, { now: t }), true);
    assert.equal(client.webhooks.constructEvent(body, header, secret, { now: t }).id, 'whe_1');
  });
});

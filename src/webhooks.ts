import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from './errors.js';
import type { WebhookEvent } from './types.js';

/** Headers on every webhook delivery (brand-neutral on purpose). */
export const WEBHOOK_HEADERS = {
  event: 'x-webhook-event',
  delivery: 'x-webhook-delivery',
  timestamp: 'x-webhook-timestamp',
  signature: 'x-webhook-signature',
} as const;

/** Deliveries older (or newer) than this many seconds are refused by default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A request's headers: a fetch `Headers`, Node's `IncomingHttpHeaders`, or a plain object. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export interface VerifyOptions {
  /** Seconds a delivery may be off from now (default 300). */
  toleranceSeconds?: number;
  /** Current time in Unix seconds (for tests). */
  now?: number;
}

type Payload = string | Uint8Array;

/**
 * Checks a delivery's `X-Webhook-Signature` (`t=<unix>,v1=<hex>`): the
 * HMAC-SHA256 of `${t}.${rawBody}` keyed with the subscription's signing
 * secret, and a timestamp within the tolerance. Pass the **raw** body: re-
 * serialised JSON has different bytes. `secret` may be a list (old and new
 * secret while you rotate). `signature` is the header value, or the request's
 * headers.
 */
export function verifyWebhookSignature(
  payload: Payload,
  signature: string | HeaderSource | null | undefined,
  secret: string | readonly string[],
  options: VerifyOptions = {},
): boolean {
  try {
    checkSignature(payload, signature, secret, options);
    return true;
  } catch (err) {
    if (err instanceof WebhookSignatureError) return false;
    throw err;
  }
}

/**
 * Verifies the signature and returns the parsed event, or throws
 * `WebhookSignatureError`.
 *
 * ```ts
 * app.post('/hooks', express.raw({ type: 'application/json' }), (req, res) => {
 *   const event = constructWebhookEvent(req.body, req.headers, process.env.WEBHOOK_SECRET!);
 *   if (event.type === 'render.completed') console.log(event.data.result?.content);
 *   res.sendStatus(204);
 * });
 * ```
 */
export function constructWebhookEvent(
  payload: Payload,
  signature: string | HeaderSource | null | undefined,
  secret: string | readonly string[],
  options: VerifyOptions = {},
): WebhookEvent {
  checkSignature(payload, signature, secret, options);
  let event: unknown;
  try {
    event = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'));
  } catch {
    throw new WebhookSignatureError('The webhook body is not JSON');
  }
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
    throw new WebhookSignatureError('The webhook body is not an event');
  }
  return event as WebhookEvent;
}

/**
 * Builds an `X-Webhook-Signature` value for a body, as the server does. For
 * testing your own endpoint.
 */
export function signWebhookPayload(payload: Payload, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, timestamp, payload)}`;
}

function checkSignature(
  payload: Payload,
  signature: string | HeaderSource | null | undefined,
  secret: string | readonly string[],
  options: VerifyOptions,
): void {
  // ArrayBuffer.isView rather than instanceof: Buffers from another realm (vm, test runners) count too.
  if (typeof payload !== 'string' && !ArrayBuffer.isView(payload)) {
    // Not a WebhookSignatureError, so verifyWebhookSignature doesn't turn the
    // mistake into a silent `false`: parsed JSON can't be verified.
    throw new TypeError(
      'Pass the raw request body (a string or Buffer, e.g. from express.raw()), not parsed JSON: re-serialised JSON has different bytes',
    );
  }
  const header = typeof signature === 'string' ? signature : readHeader(signature, WEBHOOK_HEADERS.signature);
  if (!header) throw new WebhookSignatureError('Missing X-Webhook-Signature header');
  const secrets = (typeof secret === 'string' ? [secret] : Array.isArray(secret) ? [...secret] : []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (secrets.length === 0) throw new WebhookSignatureError('No signing secret given');

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError('Malformed X-Webhook-Signature header');
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Date.now() / 1000;
  // Written as `!(age <= tolerance)` so a NaN tolerance (e.g. from an unset
  // environment variable) refuses the delivery instead of skipping the check.
  if (!(Math.abs(now - timestamp) <= tolerance)) {
    throw new WebhookSignatureError('Webhook timestamp is outside the tolerance (a replay, or a clock problem)');
  }

  for (const key of secrets) {
    const expected = Buffer.from(hmacHex(key, timestamp, payload), 'hex');
    for (const candidate of signatures) {
      if (timingSafeEqual(expected, Buffer.from(candidate, 'hex'))) return;
    }
  }
  throw new WebhookSignatureError('Webhook signature does not match');
}

function hmacHex(secret: string, timestamp: number, payload: Payload): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
}

function readHeader(headers: HeaderSource | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

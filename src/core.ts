import { BRAND } from './brand.js';
import {
  APIConnectionError,
  APITimeoutError,
  RateLimitError,
  SDKError,
  errorForStatus,
} from './errors.js';
import type { Pagination } from './types.js';
import { VERSION } from './version.js';

export interface ClientOptions {
  /** API key (`jf_live_…`). Defaults to the `JAMFRAME_API_KEY` environment variable. */
  apiKey?: string;
  /**
   * The API's origin (`https://api.jamframe.com`) or its root (`…/v1`; the
   * older `…/api/v1` also works). Defaults to `JAMFRAME_BASE_URL`, then production.
   */
  baseUrl?: string;
  /** Per-request timeout in ms (default 120 000: a synchronous MP4 render can take 90 s). */
  timeoutMs?: number;
  /** Retries after the first attempt (default 2). See README "Retries". */
  maxRetries?: number;
  /** A `Retry-After` longer than this (ms, default 60 000) is not waited for: the 429 is thrown. */
  maxRetryDelayMs?: number;
  /** A fetch implementation (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** Prepended to the User-Agent header, e.g. `my-app/1.2`. */
  userAgent?: string;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Test hooks: replace the sleep between retries and polls, the clock and the jitter. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Options every call accepts as its last argument. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
  /** Overrides the client's `maxRetries` for this call. */
  maxRetries?: number;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestSpec {
  query?: Query;
  body?: unknown;
  /** A multipart upload, sent instead of a JSON `body`. */
  form?: FormData;
  /** Safe to repeat after a 5xx or a network error (GET, DELETE, and side-effect-free POSTs). */
  idempotent?: boolean;
  options?: RequestOptions | undefined;
}

export interface RawResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const MAX_BACKOFF_MS = 8_000;

/**
 * Resolves `https://host`, `https://host/` or `https://host/v1` to
 * `https://host/v1`. A URL ending in the older `/api/v1` is kept as given.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SDKError(`baseUrl is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SDKError('baseUrl must be http(s)');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function env(name: string): string | undefined {
  const value = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return value && value.trim() ? value.trim() : undefined;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The HTTP layer: auth, timeouts, error mapping and retries. */
export class BaseClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxRetryDelayMs: number;
  protected readonly apiKey: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly headers: Record<string, string>;
  /** @internal */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** @internal */
  readonly now: () => number;
  /** @internal */
  readonly random: () => number;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env(BRAND.apiKeyEnv);
    if (!apiKey) {
      throw new SDKError(`No API key: pass { apiKey } or set ${BRAND.apiKeyEnv}`);
    }
    const fetchImpl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchImpl) throw new SDKError('No fetch implementation: use Node 18+ or pass { fetch }');
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? env(BRAND.baseUrlEnv) ?? BRAND.defaultBaseUrl);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.fetchImpl = fetchImpl;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    const ua = `${BRAND.userAgentPrefix}/${VERSION} node/${typeof process !== 'undefined' ? process.version : 'unknown'}`;
    this.headers = {
      ...options.defaultHeaders,
      Accept: 'application/json',
      'User-Agent': options.userAgent ? `${options.userAgent} ${ua}` : ua,
    };
  }

  /** Delay before retry number `attempt + 1`: exponential, capped, with jitter. */
  protected backoffMs(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    return base * (0.5 + this.random() / 2);
  }

  /**
   * Sends one API request (paths are relative to `/v1`). The typed
   * methods use it; it's public for endpoints this version doesn't wrap yet.
   */
  async request<T>(method: string, path: string, spec: RequestSpec = {}): Promise<RawResponse<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { ...this.headers, Authorization: `Bearer ${this.apiKey}` };
    let body: string | FormData | undefined;
    if (spec.form) {
      // fetch sets the multipart Content-Type with its boundary.
      body = spec.form;
    } else if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }
    const signal = spec.options?.signal;
    const timeoutMs = spec.options?.timeoutMs ?? this.timeoutMs;
    const maxRetries = Math.max(0, spec.options?.maxRetries ?? this.maxRetries);
    const idempotent = spec.idempotent ?? (method === 'GET' || method === 'DELETE');

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await this.send(url, { method, headers, body }, timeoutMs, signal));
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (canRetry && idempotent && err instanceof APIConnectionError) {
          await this.sleep(this.backoffMs(attempt), signal);
          continue;
        }
        throw err;
      }

      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (response.ok) {
        if (typeof parsed === 'string') {
          throw new SDKError(`Expected JSON from ${method} ${path}, got: ${parsed.slice(0, 200)}`);
        }
        return { status: response.status, data: parsed as T, headers: response.headers };
      }

      const error = errorForStatus(response.status, parsed, response.headers);
      if (canRetry && error instanceof RateLimitError) {
        // The rate limiter answers before any handler runs, so even a render
        // can be sent again: nothing happened the first time.
        const waitMs = error.retryAfter !== undefined ? error.retryAfter * 1000 : this.backoffMs(attempt);
        if (waitMs <= this.maxRetryDelayMs) {
          await this.sleep(waitMs, signal);
          continue;
        }
      } else if (canRetry && idempotent && response.status >= 500) {
        await this.sleep(this.backoffMs(attempt), signal);
        continue;
      }
      throw error;
    }
  }

  private async send(
    url: URL,
    init: { method: string; headers: Record<string, string>; body: string | FormData | undefined },
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; text: string }> {
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (timedOut) {
        throw new APITimeoutError(`${init.method} ${url.pathname} timed out after ${timeoutMs} ms`, { cause: err });
      }
      throw new APIConnectionError(
        `${init.method} ${url.origin}${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Iterates every item of a cursor-paginated list. */
export async function* paginate<P extends { pagination: Pagination }, T>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  items: (page: P) => T[],
  startCursor?: string,
): AsyncGenerator<T, void, undefined> {
  let cursor = startCursor;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* items(page);
    if (!page.pagination.hasMore || !page.pagination.nextCursor) return;
    cursor = page.pagination.nextCursor;
  }
}


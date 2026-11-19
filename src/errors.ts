import type { ApiErrorBody, DesignGenerateJob, RenderJob } from './types.js';

/** Base class of every error this SDK throws. */
export class SDKError extends Error {
  override name = 'SDKError';
}

/**
 * The API answered with a non-2xx status. `code` is the envelope's stable
 * `error` field (e.g. `QUOTA_EXCEEDED`), `message` its human-readable text,
 * `detail` its optional structured context.
 */
export class APIError extends SDKError {
  override name = 'APIError';
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;
  readonly headers: Headers;
  /** The parsed body (or the raw text when it wasn't JSON). */
  readonly body: unknown;

  constructor(status: number, body: unknown, headers: Headers) {
    const envelope = asEnvelope(body);
    super(envelope?.message ?? `HTTP ${status}${typeof body === 'string' && body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
    this.code = envelope?.error ?? `HTTP_${status}`;
    this.detail = envelope?.detail;
    this.headers = headers;
    this.body = body;
  }

  /** The envelope's `error` field (same as `code`). */
  get error(): string {
    return this.code;
  }
}

/** 400: an invalid request (`VALIDATION_ERROR`, `INVALID_REQUEST`, `WEBHOOK_URL_INVALID`). */
export class BadRequestError extends APIError {
  override name = 'BadRequestError';
}
/** 401: missing, invalid, expired or revoked API key. */
export class AuthenticationError extends APIError {
  override name = 'AuthenticationError';
}
/** 402: not enough credits (`QUOTA_EXCEEDED`, `WORKSPACE_QUOTA_EXCEEDED`, `AI_CREDITS_EXCEEDED`) or a plan limit (`PLAN_LIMIT_EXCEEDED`, `WEBHOOK_LIMIT_REACHED`). */
export class PaymentRequiredError extends APIError {
  override name = 'PaymentRequiredError';
}
/** 403: the organization is on hold (`ORG_ON_HOLD`) or suspended (`ORG_SUSPENDED`). */
export class PermissionDeniedError extends APIError {
  override name = 'PermissionDeniedError';
}
/** 404: no such template, job, post or subscription in this workspace. */
export class NotFoundError extends APIError {
  override name = 'NotFoundError';
}
/** 409: e.g. canceling a post that already went out. */
export class ConflictError extends APIError {
  override name = 'ConflictError';
}
/**
 * 422: an image, video, audio or subtitle URL could not be loaded, or the AI
 * refused or couldn't process the input (`AI_CONTENT_REFUSED`,
 * `AI_BAD_REQUEST`). No credits were charged.
 */
export class UnprocessableEntityError extends APIError {
  override name = 'UnprocessableEntityError';
}
/** 429: rate limited. `retryAfter` is in seconds when the API said. */
export class RateLimitError extends APIError {
  override name = 'RateLimitError';
  readonly retryAfter: number | undefined;
  constructor(status: number, body: unknown, headers: Headers) {
    super(status, body, headers);
    this.retryAfter = retryAfterSeconds(headers, asEnvelope(body)?.detail);
  }
}
/**
 * 5xx: the server failed, or a feature is off (`503 AI_UNAVAILABLE`,
 * `VIDEO_UNAVAILABLE`). A failed render or AI call charges nothing.
 */
export class InternalServerError extends APIError {
  override name = 'InternalServerError';
}

/** The request never got an answer (DNS, refused connection, reset…). */
export class APIConnectionError extends SDKError {
  override name = 'APIConnectionError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The request took longer than `timeoutMs`. */
export class APITimeoutError extends APIConnectionError {
  override name = 'APITimeoutError';
}

/** A render job ended `failed`. `code`/`message` come from the job's error. No credits were charged. */
export class RenderJobFailedError extends SDKError {
  override name = 'RenderJobFailedError';
  readonly job: RenderJob;
  readonly code: string;
  constructor(job: RenderJob) {
    super(job.error?.message ?? `Render job ${job.id} failed`);
    this.job = job;
    this.code = job.error?.error ?? 'INTERNAL';
  }
}

/** A design generation ended `failed`. `code`/`message` come from the job's error. Its AI credits were refunded. */
export class DesignJobFailedError extends SDKError {
  override name = 'DesignJobFailedError';
  readonly job: DesignGenerateJob;
  readonly code: string;
  constructor(job: DesignGenerateJob) {
    super(job.error?.message ?? `Design generation ${job.jobId} failed`);
    this.job = job;
    this.code = job.error?.error ?? 'INTERNAL';
  }
}

/**
 * Waiting for a job (a render job, a design generation or a workflow run)
 * took longer than allowed. The job keeps running on the server.
 */
export class WaitTimeoutError<J extends { status: string } = RenderJob> extends SDKError {
  override name = 'WaitTimeoutError';
  readonly jobId: string;
  /** The job as last seen. */
  readonly lastJob: J | undefined;
  constructor(jobId: string, timeoutMs: number, lastJob?: J, what = 'Render job') {
    super(`${what} ${jobId} did not finish within ${Math.round(timeoutMs / 1000)} s (last status: ${lastJob?.status ?? 'unknown'})`);
    this.jobId = jobId;
    this.lastJob = lastJob;
  }
}

/** A webhook delivery's signature didn't verify (or its body isn't an event). */
export class WebhookSignatureError extends SDKError {
  override name = 'WebhookSignatureError';
}

/** The error class for a status code. */
export function errorForStatus(status: number, body: unknown, headers: Headers): APIError {
  switch (status) {
    case 400:
      return new BadRequestError(status, body, headers);
    case 401:
      return new AuthenticationError(status, body, headers);
    case 402:
      return new PaymentRequiredError(status, body, headers);
    case 403:
      return new PermissionDeniedError(status, body, headers);
    case 404:
      return new NotFoundError(status, body, headers);
    case 409:
      return new ConflictError(status, body, headers);
    case 422:
      return new UnprocessableEntityError(status, body, headers);
    case 429:
      return new RateLimitError(status, body, headers);
    default:
      return status >= 500 ? new InternalServerError(status, body, headers) : new APIError(status, body, headers);
  }
}

function asEnvelope(body: unknown): ApiErrorBody | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { error, message, detail } = body as Record<string, unknown>;
  if (typeof error !== 'string') return undefined;
  return {
    error,
    message: typeof message === 'string' ? message : error,
    ...(detail && typeof detail === 'object' ? { detail: detail as Record<string, unknown> } : {}),
  };
}

/** `Retry-After` (seconds or an HTTP date), else the envelope's `detail.retryAfter`. */
export function retryAfterSeconds(headers: Headers, detail?: Record<string, unknown>): number | undefined {
  const raw = headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  }
  const fromBody = Number(detail?.retryAfter);
  return Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : undefined;
}

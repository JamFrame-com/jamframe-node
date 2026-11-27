import { BaseClient, paginate, type ClientOptions, type RequestOptions } from './core.js';
import { DesignJobFailedError, RenderJobFailedError, SDKError, WaitTimeoutError } from './errors.js';
import type {
  AiStatus,
  AuthResult,
  BackgroundRemoval,
  Design,
  DesignDetail,
  DesignGenerateAccepted,
  DesignGenerateJob,
  DesignGenerateRequest,
  DesignPage,
  FileInput,
  ListDesignsParams,
  ListRendersParams,
  ListSocialPostsParams,
  PageParams,
  RemoveBackgroundInput,
  RenderItem,
  RenderJob,
  RenderJobAccepted,
  RenderOutput,
  RenderPage,
  RenderRequest,
  RenderResult,
  SignedUrlKeyRotation,
  SignedUrlRequest,
  SignedUrlResponse,
  SocialAccount,
  SocialAnalyticsDaily,
  SocialAnalyticsInsights,
  SocialAnalyticsOverview,
  SocialAnalyticsParams,
  SocialPost,
  SocialPostCreated,
  SocialPostInput,
  SocialPostPage,
  SucceededDesignGenerateJob,
  SucceededRenderJob,
  TranscribeInput,
  Transcription,
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionPage,
  WebhookSubscriptionWithSecret,
  WebhookTestResult,
  Workflow,
  WorkflowCreateInput,
  WorkflowRun,
  WorkflowRunPage,
  WorkflowRunRequest,
  WorkflowRunWithRows,
  WorkflowUpdateInput,
} from './types.js';
import { constructWebhookEvent, verifyWebhookSignature } from './webhooks.js';

/** How long and how often to poll a job (a render job, a design generation or a workflow run). */
export interface WaitOptions<J = RenderJob> {
  /** Give up after this many ms (default 600 000, 10 minutes). The job keeps running. */
  timeoutMs?: number;
  /** First delay between polls (default 1000 ms); grows ×1.5 up to 5 s. */
  pollIntervalMs?: number;
  /** Called with the job after every poll (e.g. to show `progress`). */
  onProgress?: (job: J) => void;
  signal?: AbortSignal;
}

/** A design generation without `async` and `webhookUrl` (the method decides). */
export type GenerateDesignParams = Omit<DesignGenerateRequest, 'async' | 'webhookUrl'>;

export interface GenerateCallOptions extends RequestOptions {
  /** If the design takes longer than the API's ~25 s wait: how long to keep polling (default 10 minutes). */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** A render request without `async` (the method decides). */
export type RenderParams = Omit<RenderRequest, 'async'>;

export interface RenderCallOptions extends RequestOptions {
  /** If the API hands back a job (an MP4 still rendering after 90 s): how long to wait for it. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (job: RenderJob) => void;
}

const enc = encodeURIComponent;
const MAX_POLL_INTERVAL_MS = 5_000;
const FINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'partial', 'failed', 'canceled']);

/**
 * Client for the v1 API.
 *
 * ```ts
 * const client = new Client({ apiKey: process.env.JAMFRAME_API_KEY });
 * const { data } = await client.render({ templateId, modifications: { title: 'Hello' } });
 * ```
 */
export class Client extends BaseClient {
  readonly designs: Designs;
  readonly designJobs: DesignJobs;
  readonly renders: Renders;
  readonly renderJobs: RenderJobs;
  readonly signedUrls: SignedUrls;
  readonly social: Social;
  readonly workflows: Workflows;
  readonly ai: Ai;
  readonly webhooks: Webhooks;

  constructor(options: ClientOptions = {}) {
    super(options);
    this.designs = new Designs(this);
    this.designJobs = new DesignJobs(this);
    this.renders = new Renders(this);
    this.renderJobs = new RenderJobs(this);
    this.signedUrls = new SignedUrls(this);
    this.social = new Social(this);
    this.workflows = new Workflows(this);
    this.ai = new Ai(this);
    this.webhooks = new Webhooks(this);
  }

  /** `POST /auth`: checks the key and names the connected workspace's owner. */
  async whoami(options?: RequestOptions): Promise<AuthResult> {
    return (await this.request<AuthResult>('POST', '/auth', { idempotent: true, options })).data;
  }

  /**
   * `POST /render`, synchronously. Images and PDFs answer at once. An MP4
   * waits up to 90 s on the server; if it's still rendering then, the API
   * hands back a job and this method polls it until it's done, so you always
   * get the files. Costs 1 credit per image or PDF page, 1 per video second.
   */
  async render(params: RenderParams, options: RenderCallOptions = {}): Promise<RenderOutput> {
    const { async: _async, ...body } = params as RenderRequest;
    const res = await this.request<{ data: RenderResult | RenderJobAccepted; warnings?: string[] }>('POST', '/render', {
      body,
      idempotent: false,
      options,
    });
    if (res.status === 202) {
      const accepted = res.data.data as RenderJobAccepted;
      const job = await this.renderJobs.wait(accepted.jobId, {
        timeoutMs: options.waitTimeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      return { data: job.result, warnings: job.warnings ?? [] };
    }
    return { data: res.data.data as RenderResult, warnings: res.data.warnings ?? [] };
  }

  /** `POST /render` with `"async": true`: queues a render job and returns its id at once. */
  async renderAsync(params: RenderParams, options?: RequestOptions): Promise<RenderJobAccepted> {
    const res = await this.request<{ data: RenderJobAccepted | RenderResult }>('POST', '/render', {
      body: { ...params, async: true },
      idempotent: false,
      options,
    });
    const data = res.data?.data as Partial<RenderJobAccepted> | undefined;
    if (!data?.jobId) throw new SDKError(`Expected a render job (202), got HTTP ${res.status}`);
    return { jobId: data.jobId, status: data.status ?? 'queued' };
  }

  /**
   * Queues a render job (`"async": true`) and polls it with backoff until it
   * succeeds. Throws `RenderJobFailedError` if it fails (no credits charged)
   * and `WaitTimeoutError` if it takes longer than `timeoutMs`.
   */
  async renderAndWait(params: RenderParams, options: WaitOptions & RequestOptions = {}): Promise<SucceededRenderJob> {
    const { jobId } = await this.renderAsync(params, options);
    return this.renderJobs.wait(jobId, options);
  }
}

abstract class Resource {
  constructor(protected readonly client: Client) {}
}

/**
 * Polls `get` until `done(job)` says so: first after `pollIntervalMs` (1 s),
 * then ×1.5 each time, at most 5 s apart. `done` may throw to end the wait.
 */
async function poll<J extends { status: string }>(
  client: Client,
  id: string,
  what: string,
  get: (options: RequestOptions) => Promise<J>,
  done: (job: J) => boolean,
  options: WaitOptions<J> & RequestOptions,
): Promise<J> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const deadline = client.now() + timeoutMs;
  let interval = Math.max(100, options.pollIntervalMs ?? 1_000);
  const requestOptions: RequestOptions = { signal: options.signal, maxRetries: options.maxRetries };
  for (;;) {
    const job = await get(requestOptions);
    options.onProgress?.(job);
    if (done(job)) return job;
    const remaining = deadline - client.now();
    if (remaining <= 0) throw new WaitTimeoutError<J>(id, timeoutMs, job, what);
    await client.sleep(Math.min(interval, remaining), options.signal);
    interval = Math.min(interval * 1.5, MAX_POLL_INTERVAL_MS);
  }
}

/** A multipart body: the file (as a Blob, named) and the other fields as strings. */
function uploadForm(file: FileInput, filename: string | undefined, fields: Record<string, unknown>): FormData {
  const form = new FormData();
  const blob =
    file instanceof Blob
      ? file
      : new Blob([file instanceof ArrayBuffer ? file : new Uint8Array(file.buffer, file.byteOffset, file.byteLength)]);
  const ownName = (file as { name?: unknown }).name;
  form.append('file', blob, filename ?? (typeof ownName === 'string' && ownName ? ownName : 'upload'));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  return form;
}

/** Templates: the workspace's own, and the template library. */
export class Designs extends Resource {
  /**
   * `GET /designs`: one page, newest first. `source: 'library'` lists the
   * template library; `q` keeps the names containing it (ignoring case).
   */
  async list(params: ListDesignsParams = {}, options?: RequestOptions): Promise<DesignPage> {
    const { source, q, cursor, limit } = params;
    return (await this.client.request<DesignPage>('GET', '/designs', { query: { source, q, cursor, limit }, options })).data;
  }

  /** Every design across pages: `for await (const d of client.designs.iterate({ source: 'library', q: 'reel' }))`. */
  iterate(params: Omit<ListDesignsParams, 'cursor'> = {}, options?: RequestOptions): AsyncGenerator<Design> {
    return paginate((cursor) => this.list({ ...params, cursor }, options), (page) => page.designs);
  }

  /** `GET /designs/{id}`: a workspace or library template with its pages, parameters and saved sizes. */
  async get(id: string, options?: RequestOptions): Promise<DesignDetail> {
    return (await this.client.request<{ design: DesignDetail }>('GET', `/designs/${enc(id)}`, { options })).data.design;
  }

  /**
   * `POST /designs/generate`: the design agent designs a new template from a
   * description and saves it in the workspace (brand kit applied, parameter
   * keys set). The API waits about 25 s; if the design takes longer, this
   * method polls the job, so you always get the design. Costs 15 to 30 AI
   * credits, refunded when it fails (`DesignJobFailedError`).
   */
  async generate(params: GenerateDesignParams, options: GenerateCallOptions = {}): Promise<SucceededDesignGenerateJob> {
    const { async: _async, webhookUrl: _webhookUrl, ...body } = params as DesignGenerateRequest;
    const res = await this.client.request<{ data: DesignGenerateJob }>('POST', '/designs/generate', {
      body,
      idempotent: false,
      options,
    });
    const job = res.data.data;
    if (job.status === 'failed') throw new DesignJobFailedError(job);
    if (job.status === 'succeeded' && job.design) return job as SucceededDesignGenerateJob;
    return this.client.designJobs.wait(job.jobId, {
      timeoutMs: options.waitTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      signal: options.signal,
    });
  }

  /**
   * `POST /designs/generate` with `"async": true`: starts the generation and
   * returns its job id at once. Poll it with `designJobs.wait()`, or pass a
   * `webhookUrl` to be called when it ends.
   */
  async generateAsync(params: Omit<DesignGenerateRequest, 'async'>, options?: RequestOptions): Promise<DesignGenerateAccepted> {
    const res = await this.client.request<{ data: DesignGenerateAccepted | DesignGenerateJob }>('POST', '/designs/generate', {
      body: { ...params, async: true },
      idempotent: false,
      options,
    });
    const data = res.data?.data as Partial<DesignGenerateAccepted> | undefined;
    if (!data?.jobId) throw new SDKError(`Expected a design job (202), got HTTP ${res.status}`);
    return { jobId: data.jobId, status: 'running' };
  }
}

/** Design generations started by `designs.generate()` or `designs.generateAsync()`. */
export class DesignJobs extends Resource {
  /** `GET /designs/generate/{jobId}`. */
  async get(jobId: string, options?: RequestOptions): Promise<DesignGenerateJob> {
    return (await this.client.request<{ data: DesignGenerateJob }>('GET', `/designs/generate/${enc(jobId)}`, { options }))
      .data.data;
  }

  /**
   * Polls a generation until it succeeds (returned, with `design`). Throws
   * `DesignJobFailedError` when it fails and `WaitTimeoutError` after
   * `timeoutMs` (10 minutes).
   */
  async wait(
    jobId: string,
    options: WaitOptions<DesignGenerateJob> & RequestOptions = {},
  ): Promise<SucceededDesignGenerateJob> {
    const job = await poll(
      this.client,
      jobId,
      'Design generation',
      (requestOptions) => this.get(jobId, requestOptions),
      (job) => {
        if (job.status === 'failed') throw new DesignJobFailedError(job);
        return job.status === 'succeeded' && !!job.design;
      },
      options,
    );
    return job as SucceededDesignGenerateJob;
  }
}

/** The render log. */
export class Renders extends Resource {
  /** `GET /renders`: one page, newest first, with this period's credit `totals`. */
  async list(params: ListRendersParams = {}, options?: RequestOptions): Promise<RenderPage> {
    const { status, designId, cursor, limit } = params;
    return (
      await this.client.request<RenderPage>('GET', '/renders', { query: { status, designId, cursor, limit }, options })
    ).data;
  }

  /** Every render across pages. */
  iterate(params: Omit<ListRendersParams, 'cursor'> = {}, options?: RequestOptions): AsyncGenerator<RenderItem> {
    return paginate((cursor) => this.list({ ...params, cursor }, options), (page) => page.renders);
  }

  /** `GET /renders/{id}`: one render (a `renderId` from a render or a job's result), as the log lists it. */
  async get(id: string, options?: RequestOptions): Promise<RenderItem> {
    return (await this.client.request<{ render: RenderItem }>('GET', `/renders/${enc(id)}`, { options })).data.render;
  }

  /**
   * `DELETE /renders/{id}/files`: delete the render's stored files now. The
   * render stays in the log, with `filesDeleted` true and no `outputs`.
   */
  async deleteFiles(id: string, options?: RequestOptions): Promise<RenderItem> {
    return (await this.client.request<{ render: RenderItem }>('DELETE', `/renders/${enc(id)}/files`, { options })).data
      .render;
  }
}

/** Render jobs: MP4 renders and `async` renders. */
export class RenderJobs extends Resource {
  /** `GET /render-jobs/{id}`. */
  async get(id: string, options?: RequestOptions): Promise<RenderJob> {
    return (await this.client.request<{ job: RenderJob }>('GET', `/render-jobs/${enc(id)}`, { options })).data.job;
  }

  /**
   * Polls a job until it succeeds: first after `pollIntervalMs` (1 s), then
   * ×1.5 each time, at most 5 s apart. Throws `RenderJobFailedError` when it
   * fails and `WaitTimeoutError` after `timeoutMs` (10 minutes).
   */
  async wait(id: string, options: WaitOptions & RequestOptions = {}): Promise<SucceededRenderJob> {
    const job = await poll(
      this.client,
      id,
      'Render job',
      (requestOptions) => this.get(id, requestOptions),
      (job) => {
        if (job.status === 'failed') throw new RenderJobFailedError(job);
        return job.status === 'succeeded' && !!job.result;
      },
      options,
    );
    return job as SucceededRenderJob;
  }
}

/** Signed render URLs: a tamper-proof public link that renders when opened. */
export class SignedUrls extends Resource {
  /** `POST /signed-urls`. Nothing is rendered or charged until the URL is opened. */
  async create(params: SignedUrlRequest, options?: RequestOptions): Promise<SignedUrlResponse> {
    // Signing stores nothing, so it is safe to retry.
    return (await this.client.request<SignedUrlResponse>('POST', '/signed-urls', { body: params, idempotent: true, options }))
      .data;
  }

  /** `POST /signed-urls/rotate-key`: every signed URL made so far stops working. */
  async rotateKey(options?: RequestOptions): Promise<SignedUrlKeyRotation> {
    return (
      await this.client.request<{ data: SignedUrlKeyRotation }>('POST', '/signed-urls/rotate-key', {
        idempotent: false,
        options,
      })
    ).data.data;
  }
}

/** Connected social accounts (connected in the app). */
export class SocialAccounts extends Resource {
  /** `GET /social/accounts`. */
  async list(options?: RequestOptions): Promise<SocialAccount[]> {
    return (await this.client.request<{ accounts: SocialAccount[] }>('GET', '/social/accounts', { options })).data.accounts;
  }
}

/** Social posts: render and post, now, scheduled, or as a draft. */
export class SocialPosts extends Resource {
  /**
   * `POST /social/posts`. Every account is checked first; if any can't take
   * the post, nothing is created and a `BadRequestError` lists the problems
   * in `detail.targets`. Publishing then runs in the background.
   */
  async create(input: SocialPostInput, options?: RequestOptions): Promise<SocialPostCreated> {
    return (await this.client.request<SocialPostCreated>('POST', '/social/posts', { body: input, idempotent: false, options }))
      .data;
  }

  /** `GET /social/posts`: one page, newest first. */
  async list(params: ListSocialPostsParams = {}, options?: RequestOptions): Promise<SocialPostPage> {
    const { status, cursor, limit } = params;
    return (await this.client.request<SocialPostPage>('GET', '/social/posts', { query: { status, cursor, limit }, options }))
      .data;
  }

  /** Every post across pages. */
  iterate(params: Omit<ListSocialPostsParams, 'cursor'> = {}, options?: RequestOptions): AsyncGenerator<SocialPost> {
    return paginate((cursor) => this.list({ ...params, cursor }, options), (page) => page.posts);
  }

  /** `GET /social/posts/{id}`: each account's status, permalink and error. */
  async get(id: string, options?: RequestOptions): Promise<SocialPost> {
    return (await this.client.request<{ post: SocialPost }>('GET', `/social/posts/${enc(id)}`, { options })).data.post;
  }

  /** `POST /social/posts/{id}/cancel`: cancels what hasn't gone out. */
  async cancel(id: string, options?: RequestOptions): Promise<SocialPost> {
    return (
      await this.client.request<{ post: SocialPost }>('POST', `/social/posts/${enc(id)}/cancel`, { idempotent: false, options })
    ).data.post;
  }

  /** `POST /social/posts/{id}/retry`: queues the failed accounts again (or one, by `targetId`). */
  async retry(id: string, params: { targetId?: string } = {}, options?: RequestOptions): Promise<SocialPost> {
    return (
      await this.client.request<{ post: SocialPost }>('POST', `/social/posts/${enc(id)}/retry`, {
        body: params.targetId ? { targetId: params.targetId } : {},
        idempotent: false,
        options,
      })
    ).data.post;
  }
}

/**
 * What the workspace's posts gained (impressions or views, reach, likes,
 * comments, shares, saves, clicks, engagement). A metric is `null` when the
 * platforms in scope don't report it.
 */
export class SocialAnalytics extends Resource {
  /** `GET /social/analytics/overview`: totals for the range, the period before, and the change in percent. */
  async overview(params: SocialAnalyticsParams = {}, options?: RequestOptions): Promise<SocialAnalyticsOverview> {
    return this.get<SocialAnalyticsOverview>('overview', params, options);
  }

  /** `GET /social/analytics/daily`: one row per day, oldest first. */
  async daily(params: SocialAnalyticsParams = {}, options?: RequestOptions): Promise<SocialAnalyticsDaily> {
    return this.get<SocialAnalyticsDaily>('daily', params, options);
  }

  /** `GET /social/analytics/insights`: the top posts, the best weekday and hour to post, and each platform. */
  async insights(params: SocialAnalyticsParams = {}, options?: RequestOptions): Promise<SocialAnalyticsInsights> {
    return this.get<SocialAnalyticsInsights>('insights', params, options);
  }

  private async get<T>(report: string, params: SocialAnalyticsParams, options?: RequestOptions): Promise<T> {
    const list = (value?: string | string[]) => (Array.isArray(value) ? value.join(',') : value);
    const query = { from: params.from, to: params.to, platform: list(params.platform), accountId: list(params.accountId) };
    return (await this.client.request<T>('GET', `/social/analytics/${report}`, { query, options })).data;
  }
}

export class Social {
  readonly accounts: SocialAccounts;
  readonly posts: SocialPosts;
  readonly analytics: SocialAnalytics;
  constructor(client: Client) {
    this.accounts = new SocialAccounts(client);
    this.posts = new SocialPosts(client);
    this.analytics = new SocialAnalytics(client);
  }
}

/**
 * Workflows: rows from a sheet, a file, Airtable or a webhook, each rendered
 * with a template and delivered. Build them in the app or here.
 */
export class Workflows extends Resource {
  readonly runs: WorkflowRuns;
  constructor(client: Client) {
    super(client);
    this.runs = new WorkflowRuns(client);
  }

  /** `GET /workflows`: most recently changed first (at most 200). */
  async list(options?: RequestOptions): Promise<Workflow[]> {
    return (await this.client.request<{ workflows: Workflow[] }>('GET', '/workflows', { options })).data.workflows;
  }

  /** `GET /workflows/{id}`. */
  async get(id: string, options?: RequestOptions): Promise<Workflow> {
    return (await this.client.request<{ workflow: Workflow }>('GET', `/workflows/${enc(id)}`, { options })).data.workflow;
  }

  /**
   * `POST /workflows`: a draft from a `definition`, from an Explore `starter`,
   * or a blank draft. What it still needs before it can run is in `problems`.
   */
  async create(input: WorkflowCreateInput = {}, options?: RequestOptions): Promise<Workflow> {
    return (
      await this.client.request<{ workflow: Workflow }>('POST', '/workflows', { body: input, idempotent: false, options })
    ).data.workflow;
  }

  /** `PATCH /workflows/{id}`: the fields sent replace the old ones. `status: 'active'` needs a complete definition. */
  async update(id: string, input: WorkflowUpdateInput, options?: RequestOptions): Promise<Workflow> {
    return (
      await this.client.request<{ workflow: Workflow }>('PATCH', `/workflows/${enc(id)}`, {
        body: input,
        idempotent: true,
        options,
      })
    ).data.workflow;
  }

  /** `DELETE /workflows/{id}`: the workflow and its run history. Renders and posts it made stay. */
  async delete(id: string, options?: RequestOptions): Promise<void> {
    await this.client.request<void>('DELETE', `/workflows/${enc(id)}`, { options });
  }

  /**
   * `POST /workflows/{id}/run`: queues a run now (drafts included) and
   * returns it. Each row costs render credits. `maxRows` makes a test run.
   */
  async run(id: string, params: WorkflowRunRequest = {}, options?: RequestOptions): Promise<WorkflowRun> {
    return (
      await this.client.request<{ run: WorkflowRun }>('POST', `/workflows/${enc(id)}/run`, {
        body: params,
        idempotent: false,
        options,
      })
    ).data.run;
  }

  /** Queues a run and polls it until it ends; returns it with each row's result. Check `status`. */
  async runAndWait(
    id: string,
    params: WorkflowRunRequest = {},
    options: WaitOptions<WorkflowRunWithRows> & RequestOptions = {},
  ): Promise<WorkflowRunWithRows> {
    const run = await this.run(id, params, options);
    return this.runs.wait(id, run.id, options);
  }

  /** `POST /workflows/{id}/webhook-token`: a new incoming webhook URL. The old one stops working at once. */
  async rotateWebhookUrl(id: string, options?: RequestOptions): Promise<string> {
    return (
      await this.client.request<{ webhookUrl: string }>('POST', `/workflows/${enc(id)}/webhook-token`, {
        idempotent: false,
        options,
      })
    ).data.webhookUrl;
  }
}

/** A workflow's runs. */
export class WorkflowRuns extends Resource {
  /** `GET /workflows/{id}/runs`: one page, newest first. */
  async list(workflowId: string, params: PageParams = {}, options?: RequestOptions): Promise<WorkflowRunPage> {
    const { cursor, limit } = params;
    return (
      await this.client.request<WorkflowRunPage>('GET', `/workflows/${enc(workflowId)}/runs`, {
        query: { cursor, limit },
        options,
      })
    ).data;
  }

  /** Every run across pages. */
  iterate(workflowId: string, params: Omit<PageParams, 'cursor'> = {}, options?: RequestOptions): AsyncGenerator<WorkflowRun> {
    return paginate((cursor) => this.list(workflowId, { ...params, cursor }, options), (page) => page.runs);
  }

  /** `GET /workflows/{id}/runs/{runId}`: the run with each row's result (at most 1,000 rows). */
  async get(workflowId: string, runId: string, options?: RequestOptions): Promise<WorkflowRunWithRows> {
    return (
      await this.client.request<{ run: WorkflowRunWithRows }>('GET', `/workflows/${enc(workflowId)}/runs/${enc(runId)}`, {
        options,
      })
    ).data.run;
  }

  /** `POST …/runs/{runId}/cancel`: rows not started yet are skipped. A finished run is a `ConflictError`. */
  async cancel(workflowId: string, runId: string, options?: RequestOptions): Promise<WorkflowRun> {
    return (
      await this.client.request<{ run: WorkflowRun }>(
        'POST',
        `/workflows/${enc(workflowId)}/runs/${enc(runId)}/cancel`,
        { idempotent: false, options },
      )
    ).data.run;
  }

  /**
   * Polls a run until it ends (`succeeded`, `partial`, `failed` or
   * `canceled`) and returns it; it doesn't throw for a failed run. Throws
   * `WaitTimeoutError` after `timeoutMs` (10 minutes).
   */
  async wait(
    workflowId: string,
    runId: string,
    options: WaitOptions<WorkflowRunWithRows> & RequestOptions = {},
  ): Promise<WorkflowRunWithRows> {
    return poll(
      this.client,
      runId,
      'Workflow run',
      (requestOptions) => this.get(workflowId, runId, requestOptions),
      (run) => FINAL_RUN_STATUSES.has(run.status),
      options,
    );
  }
}

/** AI calls that aren't renders. They spend AI credits, refunded when a call fails. */
export class Ai extends Resource {
  /** `GET /ai/status`: whether AI runs, the price list and the organization's AI credits. Free. */
  async status(options?: RequestOptions): Promise<AiStatus> {
    return (await this.client.request<AiStatus>('GET', '/ai/status', { options })).data;
  }

  /**
   * `POST /images/remove-background`: cuts the subject out of a picture (a
   * URL, or a file to upload) and stores a transparent PNG in the brand
   * library; `url` is ready for an image parameter. 1 AI credit.
   */
  async removeBackground(input: RemoveBackgroundInput, options?: RequestOptions): Promise<BackgroundRemoval> {
    const spec =
      input.file !== undefined
        ? { form: uploadForm(input.file, input.filename, { name: input.name }) }
        : { body: { url: input.url, name: input.name } };
    return (
      await this.client.request<BackgroundRemoval>('POST', '/images/remove-background', {
        ...spec,
        idempotent: false,
        options,
      })
    ).data;
  }

  /**
   * `POST /ai/transcribe`: the speech in an audio file or a video's sound as
   * subtitle cues, SRT and WebVTT. Pass `cues` as `modifications.subtitles`
   * in an MP4 render. 1 AI credit per minute of audio.
   */
  async transcribe(input: TranscribeInput, options?: RequestOptions): Promise<Transcription> {
    const { url, file, filename, ...fields } = input as TranscribeInput & { url?: string; file?: FileInput; filename?: string };
    const spec = file !== undefined ? { form: uploadForm(file, filename, fields) } : { body: { url, ...fields } };
    return (
      await this.client.request<Transcription>('POST', '/ai/transcribe', { ...spec, idempotent: false, options })
    ).data;
  }
}

/** Webhook subscriptions of the key's workspace. */
export class WebhookSubscriptions extends Resource {
  async list(params: { cursor?: string; limit?: number } = {}, options?: RequestOptions): Promise<WebhookSubscriptionPage> {
    const { cursor, limit } = params;
    return (
      await this.client.request<WebhookSubscriptionPage>('GET', '/webhooks/subscriptions', { query: { cursor, limit }, options })
    ).data;
  }

  iterate(params: { limit?: number } = {}, options?: RequestOptions): AsyncGenerator<WebhookSubscription> {
    return paginate((cursor) => this.list({ ...params, cursor }, options), (page) => page.subscriptions);
  }

  async get(id: string, options?: RequestOptions): Promise<WebhookSubscription> {
    return (
      await this.client.request<{ subscription: WebhookSubscription }>('GET', `/webhooks/subscriptions/${enc(id)}`, { options })
    ).data.subscription;
  }

  /** Subscribe a URL to events. The `signingSecret` is returned once: store it. */
  async create(input: WebhookSubscriptionInput, options?: RequestOptions): Promise<WebhookSubscriptionWithSecret> {
    return (
      await this.client.request<WebhookSubscriptionWithSecret>('POST', '/webhooks/subscriptions', {
        body: input,
        idempotent: false,
        options,
      })
    ).data;
  }

  async delete(id: string, options?: RequestOptions): Promise<void> {
    await this.client.request<void>('DELETE', `/webhooks/subscriptions/${enc(id)}`, { options });
  }

  /** Queues a signed sample delivery of `eventType` (default: the subscription's first event). */
  async test(id: string, eventType?: WebhookEventType, options?: RequestOptions): Promise<WebhookTestResult> {
    return (
      await this.client.request<WebhookTestResult>('POST', `/webhooks/subscriptions/${enc(id)}/test`, {
        body: eventType ? { eventType } : {},
        idempotent: false,
        options,
      })
    ).data;
  }

  /** A new signing secret; the old one stops working at once. */
  async rotateSecret(id: string, options?: RequestOptions): Promise<WebhookSubscriptionWithSecret> {
    return (
      await this.client.request<WebhookSubscriptionWithSecret>('POST', `/webhooks/subscriptions/${enc(id)}/rotate-secret`, {
        idempotent: false,
        options,
      })
    ).data;
  }
}

export class Webhooks {
  readonly subscriptions: WebhookSubscriptions;
  /** Same as the top-level `verifyWebhookSignature`. */
  readonly verifySignature = verifyWebhookSignature;
  /** Same as the top-level `constructWebhookEvent`. */
  readonly constructEvent = constructWebhookEvent;
  constructor(client: Client) {
    this.subscriptions = new WebhookSubscriptions(client);
  }
}

/** Every file URL of a render result: a string, a page array, or each size's `url`/`urls`, flattened. */
export function fileUrls(content: RenderResult['content']): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  const urls: string[] = [];
  for (const entry of content) {
    if (typeof entry === 'string') urls.push(entry);
    else if (entry.url) urls.push(entry.url);
    else if (entry.urls) urls.push(...entry.urls);
  }
  return urls;
}

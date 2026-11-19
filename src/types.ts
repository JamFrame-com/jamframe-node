/**
 * Request and response shapes of the v1 API, transcribed from the OpenAPI
 * spec (spec/openapi.yaml; test/spec.test.ts checks them against it). Field
 * comments are short; the API reference has the details.
 */

// ---------------------------------------------------------------- common

/**
 * Stable error codes of the v1 envelope (`error`). Other strings may appear.
 * `INVALID_REQUEST` (400) is a body that isn't JSON, `BODY_TOO_LARGE` (413)
 * a body over 5 MB, `UNSUPPORTED_MEDIA_TYPE` (415) a charset or encoding the
 * API can't read; the `AI_*` codes come from the AI calls and AI layers.
 */
export type ApiErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'EXPIRED_API_KEY'
  | 'ORG_ON_HOLD'
  | 'ORG_SUSPENDED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'INVALID_REQUEST'
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'WORKSPACE_QUOTA_EXCEEDED'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'WEBHOOK_URL_INVALID'
  | 'WEBHOOK_LIMIT_REACHED'
  | 'VIDEO_UNAVAILABLE'
  | 'AI_UNAVAILABLE'
  | 'AI_CONTENT_REFUSED'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_BAD_OUTPUT'
  | 'AI_BAD_REQUEST'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_CREDITS_EXCEEDED'
  | 'INTERNAL';

/** The body of every non-2xx answer. */
export interface ApiErrorBody {
  error: ApiErrorCode | (string & {});
  message: string;
  detail?: Record<string, unknown>;
}

export interface Pagination {
  /** Pass as `cursor` to get the next page; `null` on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Cursor paging parameters shared by every list call. */
export interface PageParams {
  cursor?: string;
  /** 1 to 100 (default 25). */
  limit?: number;
}

/** `POST /auth`. */
export interface AuthResult {
  workspaceId?: string;
  /** Display name of the organization owner (or their email). */
  username: string;
}

// ---------------------------------------------------------------- designs

export type DesignSource = 'workspace' | 'library';

/** A template summary. Also the `data` of `design.*` webhook events. */
export interface Design {
  id: string;
  name: string;
  orientation: 'landscape' | 'portrait' | 'square';
  /** Number of pages (1 for a single image, more for a carousel; 0 only for an unreadable template). */
  pages: number;
  /**
   * A video template (animated layers, a video layer, a soundtrack, set page
   * durations or transitions): render it with `response.format: 'mp4'`.
   */
  animated: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TemplateParameterType =
  | 'text'
  | 'image'
  | 'qr'
  | 'shape'
  | 'video'
  | 'audio'
  | 'subtitles'
  | 'variable';

/** One key a render's `modifications` can set. */
export interface TemplateParameter {
  key: string;
  type: TemplateParameterType;
  /** Pages (from 1) the parameter appears on. */
  pages: number[];
  /** The value currently in the template. */
  example: string;
  /**
   * Layers filled by AI at render time: their prompt. Send `<key>.prompt`
   * to change it, or a plain value to skip the AI.
   */
  prompt?: string;
}

/** A Smart Resize size saved on the template. Pass `id` as `response.size`. */
export interface TemplateSize {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface DesignDetail extends Design {
  parameters: TemplateParameter[];
  sizes: TemplateSize[];
}

export interface DesignPage {
  designs: Design[];
  pagination: Pagination;
}

export interface ListDesignsParams extends PageParams {
  /** `workspace` (default) or `library` (the template-library presets). */
  source?: DesignSource;
  /** Only designs whose name contains this text, ignoring case (at most 100 characters). */
  q?: string;
}

/** `POST /designs/generate`: what the design agent should make. */
export interface DesignGenerateRequest {
  /** What to design (purpose, content, audience, style), up to 4000 characters. Also the name unless `name` is given. */
  prompt: string;
  /**
   * A size preset id (`instagram-post`, `instagram-story`, `linkedin-carousel`,
   * `og-image`, `a4-portrait`…), an alias (`square`, `portrait`, `story`,
   * `landscape`) or `WIDTHxHEIGHT`. Default 1080x1350. Or send `width` and `height`.
   */
  size?: string;
  width?: number;
  height?: number;
  /** Pages to design (a carousel), 1 to 10. Default 1. */
  pages?: number;
  /** An animated video template: render it as `mp4`. */
  video?: boolean;
  /** `true` (default): the workspace's brand library; `false`: no brand; or explicit values. */
  brand?: boolean | { colors?: string[]; fonts?: string[]; logo?: string };
  /** A public https PNG, JPEG, GIF or WebP to recreate or take inspiration from. */
  referenceImageUrl?: string;
  /** The design's name (up to 120 characters). */
  name?: string;
  /** Answer `202` with the job at once instead of waiting. */
  async?: boolean;
  /** With `async`: POSTed `{ event, job }` when the job ends (public http(s) URLs only). */
  webhookUrl?: string;
}

/** A design made by `POST /designs/generate`, with a link to the editor. */
export interface GeneratedDesign extends DesignDetail {
  editorUrl?: string;
}

/** A design generation job: `running`, then `succeeded` (with `design`) or `failed` (with `error`). */
export interface DesignGenerateJob {
  jobId: string;
  status: 'running' | 'succeeded' | 'failed';
  design?: GeneratedDesign;
  /** The design agent's summary of what it made. */
  message?: string;
  /** The changes it made, one line each. */
  changes?: string[];
  /** AI credits charged (refunded when the generation fails). */
  creditsCharged?: number;
  /** Made by a development server's scripted designer (no AI key). */
  mock?: boolean;
  error?: ApiErrorBody;
  createdAt: string;
  finishedAt?: string | null;
}

export interface SucceededDesignGenerateJob extends DesignGenerateJob {
  status: 'succeeded';
  design: GeneratedDesign;
}

/** The 202 answer of a generation that is still running. */
export interface DesignGenerateAccepted {
  jobId: string;
  status: 'running';
}

/** Body POSTed to a generation's `webhookUrl` (unsigned). */
export interface DesignGenerateCallback {
  event: 'design.generate.completed' | 'design.generate.failed';
  job: DesignGenerateJob;
}

// ---------------------------------------------------------------- render

export interface SubtitleCue {
  /** Seconds on the video's timeline. */
  start: number;
  end: number;
  text: string;
}

/** A value for one modification key (`null` clears it; cues only for `subtitles`). */
export type ModificationValue = string | number | boolean | null | SubtitleCue[];

/**
 * Keys: `title`, `page2@title`, `title.color`, `page2@title.color`, `audio`,
 * `audio.volume`, `subtitles`, `subtitles.style.<field>`.
 */
export type Modifications = Record<string, ModificationValue>;

export type RenderFormat = 'png' | 'jpeg' | 'jpg' | 'webp' | 'pdf' | 'mp4';
export type OutputFormat = 'png' | 'jpeg' | 'webp' | 'pdf' | 'mp4';

export interface RenderOptions {
  /** `url` (default) stores the files; `base64` returns the bytes inline (sync images and PDFs only). */
  type?: 'url' | 'base64';
  format?: RenderFormat;
  /** 1 to 3: pixel density for images. */
  scale?: number;
  /** 1 to 100, for jpeg and webp. */
  quality?: number;
  /** Pages to render, from 1 (all when omitted; at most 20 per request). */
  includePages?: number[];
  /**
   * Smart Resize: a saved size id, a size name (`story`, `square`,
   * `instagram-story`, …), `"WIDTHxHEIGHT"` or `original`.
   */
  size?: string;
  /** Smart Resize: several sizes in one sync call (not with size, mp4, async or base64). */
  sizes?: string[];
  /** MP4 only: also store the subtitles as an `.srt` or `.vtt` file. */
  subtitles?: 'srt' | 'vtt';
  /**
   * **Experimental**, PDF only: convert the colours to CMYK for print with an
   * ICC profile (`true` uses `fogra39`). The options and output may still change.
   */
  cmyk?: boolean | { profile?: CmykProfile };
  /**
   * **Experimental**, PDF only: make the file smaller (`true` uses the
   * `ebook` preset). The options and output may still change.
   */
  compress?: boolean | { preset?: 'ebook' | 'screen' | 'printer' | 'prepress'; dpi?: number };
}

/** A printing condition for `response.cmyk`. Ask your print shop which one to use. */
export type CmykProfile =
  | 'fogra39'
  | 'fogra51'
  | 'fogra52'
  | 'fogra47'
  | 'fogra29'
  | 'fogra40'
  | 'fogra45'
  | 'ifra26'
  | 'gracol2013'
  | 'gracol2013-uncoated'
  | 'swop2013'
  | 'japan2011'
  | 'gracol2006';

export interface RenderRequest {
  /** A workspace template id, a template-library template id, or a library template's slug (`tool-quote-card-paper`). */
  templateId: string;
  modifications?: Modifications;
  response?: RenderOptions;
  /** Run as a render job and answer 202 at once. */
  async?: boolean;
  /** Render jobs only (async or mp4): POSTed `{ event, job }` when the job ends. */
  webhookUrl?: string;
  /** Seconds the file links work: 300 (default) to 604800 (7 days). Not with `base64`. */
  expiresIn?: number;
  /** Translate every text layer into `lang` with AI (AI credits; cached per text and language). */
  translate?: boolean;
  /** The language for `translate`: a BCP 47 tag such as `es`, `fr`, `pt-BR`. */
  lang?: string;
  /** How AI layers and translation behave: `fail` (default) or `fallback` to the saved text and image. */
  ai?: { onError?: 'fail' | 'fallback' };
}

/** One size of a `response.sizes` render. */
export interface SizedContent {
  size: string;
  name: string;
  width: number;
  height: number;
  pages: number[];
  /** When this size is one file (one image, or a PDF). */
  url?: string;
  /** One file per page (a carousel). */
  urls?: string[];
}

/** The `data` of a successful render, and a succeeded job's `result`. */
export interface RenderResult {
  /** One URL/base64 string, an array in page order, or one entry per size with `sizes`. */
  content: string | string[] | SizedContent[];
  /** `url` renders: every file's link in one list (the same links as `content`). */
  urls?: string[];
  /** `url` renders: when the links stop working (`expiresIn` after they were handed out). */
  expiresAt?: string;
  type: 'url' | 'base64';
  format: OutputFormat;
  pages: number[];
  credits: number;
  renderId: string;
  responseTime: number;
  /** MP4 only: length in seconds. */
  duration?: number;
  /** MP4 with `response.subtitles`: the subtitle file's URL. */
  subtitles?: string;
  /** Templates with AI layers, or `translate`: AI credits charged (0 when cached). */
  aiCredits?: number;
}

/** What `render()` returns: the API's 200 body, with `warnings` always present. */
export interface RenderOutput {
  data: RenderResult;
  /** Non-fatal problems such as modification keys that matched nothing. */
  warnings: string[];
}

/** The 202 answer of a render that runs as a job. */
export interface RenderJobAccepted {
  jobId: string;
  status: 'queued' | 'running';
}

export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface RenderJob {
  id: string;
  status: RenderJobStatus;
  /** 0 to 1. */
  progress: number;
  format: OutputFormat;
  templateId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: RenderResult | null;
  error: ApiErrorBody | null;
  warnings?: string[];
}

export interface SucceededRenderJob extends RenderJob {
  status: 'succeeded';
  result: RenderResult;
}

/** Body POSTed to a render request's `webhookUrl` (unsigned). */
export interface RenderJobCallback {
  event: 'render.completed' | 'render.failed';
  job: RenderJob;
}

// ---------------------------------------------------------------- render log

export interface RenderOutputFile {
  /** A link signed for this read; it works until `expiresAt` (5 minutes). */
  url: string;
  /** The page this file shows (a PDF's first page). */
  page: number | null;
  expiresAt?: string;
}

export interface RenderItem {
  id: string;
  createdAt: string;
  designId: string | null;
  designName: string | null;
  source: 'api' | 'editor' | 'signed-url' | 'dynamic-url' | 'form' | 'workflow' | 'shopify' | 'webflow';
  format: OutputFormat;
  pages: number;
  credits: number;
  status: 'succeeded' | 'failed';
  durationMs: number;
  outputs: RenderOutputFile[];
  error: string | null;
  cached: boolean;
}

export interface RenderTotals {
  periodStart: string;
  periodEnd: string;
  creditsUsed: number;
  /** `null` when unlimited. */
  creditsQuota: number | null;
  creditsRemaining: number | null;
  workspaceCreditsUsed: number;
}

export interface RenderPage {
  renders: RenderItem[];
  pagination: Pagination;
  totals: RenderTotals;
}

export interface ListRendersParams extends PageParams {
  status?: 'succeeded' | 'failed';
  /** Only renders of this template. */
  designId?: string;
}

// ---------------------------------------------------------------- signed URLs

export interface SignedUrlRequest {
  templateId: string;
  /** Up to 50 keys, values up to 2000 characters. */
  modifications?: Record<string, string | number | boolean | null>;
  response?: {
    format?: 'png' | 'jpeg' | 'jpg' | 'webp' | 'pdf';
    scale?: number;
    quality?: number;
    includePages?: number[];
    size?: string;
  };
  /** Seconds until the URL stops working (default 7 days, at most 1 year). */
  expiresIn?: number;
  /** Seconds a render of the URL is reused (default 30 days; 0 = never). */
  cacheSeconds?: number;
}

export interface SignedUrlResponse {
  data: {
    url: string;
    templateId: string;
    format: 'png' | 'jpeg' | 'webp' | 'pdf';
    expiresAt: string;
  };
  warnings?: string[];
}

export interface SignedUrlKeyRotation {
  rotatedAt: string;
}

// ---------------------------------------------------------------- social

/**
 * `linkedin` is a profile, `linkedin_page` a company page, `facebook` a Page,
 * `pinterest` posts Pins to a board, `buffer` is a channel of a connected
 * Buffer account (the post goes into its Buffer queue).
 */
export type SocialPlatform =
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'linkedin_page'
  | 'x'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'bluesky'
  | 'buffer';

export interface SocialAccount {
  id: string;
  platform: SocialPlatform;
  platformName: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  /** `needs_reconnect`: reconnect it in the app before posting. */
  status: 'active' | 'needs_reconnect';
  statusReason?: string | null;
  /** Posting is simulated (development servers without platform keys). */
  sandbox: boolean;
  reconnectBy?: string | null;
  createdAt: string;
  lastPostedAt?: string | null;
}

export interface LinkedInPostOptions {
  firstComment?: string;
  documentTitle?: string;
  visibility?: 'PUBLIC' | 'CONNECTIONS';
}

export interface TikTokPostOptions {
  /** Send to the creator's TikTok inbox as a draft instead of posting (no `privacyLevel` needed). */
  draft?: boolean;
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  commercialContent?: boolean;
  yourBrand?: boolean;
  brandedContent?: boolean;
  aiGenerated?: boolean;
  title?: string;
  autoAddMusic?: boolean;
  videoCoverTimestampMs?: number;
}

export interface YouTubePostOptions {
  title?: string;
  privacy?: 'public' | 'unlisted' | 'private';
  madeForKids?: boolean;
  tags?: string[];
  categoryId?: string;
  aiGenerated?: boolean;
}

/** The caption is the Pin's description. Set `boardId` per account (`accounts[].options`) to pick a board. */
export interface PinterestPostOptions {
  /** The board (default: the account's first board). */
  boardId?: string;
  /** The Pin's title (100 characters). */
  title?: string;
  /** Where the Pin links to. */
  link?: string;
  altText?: string;
}

export interface BlueskyPostOptions {
  /** Alt text for the images or the video. */
  altText?: string;
}

export interface BufferPostOptions {
  /** `queue` (default): the next free slot; `next`: first in the queue; `now`: at once; `draft`: a Buffer draft. */
  mode?: 'queue' | 'next' | 'now' | 'draft';
  instagramType?: 'post' | 'story' | 'reel';
  facebookType?: 'post' | 'story' | 'reel';
  /** Default: the channel's first board. */
  pinterestBoardId?: string;
  /** Pinterest Pin title. */
  title?: string;
  /** Pinterest Pin link. */
  link?: string;
  /** YouTube category id (default 22). */
  youtubeCategoryId?: string;
}

export interface SocialPostOptions {
  instagram?: { shareToFeed?: boolean };
  facebook?: { title?: string };
  linkedin?: LinkedInPostOptions;
  linkedin_page?: LinkedInPostOptions;
  x?: Record<string, never>;
  tiktok?: TikTokPostOptions;
  youtube?: YouTubePostOptions;
  pinterest?: PinterestPostOptions;
  bluesky?: BlueskyPostOptions;
  buffer?: BufferPostOptions;
}

/** An account id, or an account with its own caption or options. */
export type SocialPostAccount =
  | string
  | { id: string; caption?: string; options?: Record<string, unknown> };

/**
 * One media source (`templateId`, `renderId` or `mediaUrls`; drafts may have
 * none), the accounts, the caption, and when.
 */
export interface SocialPostInput {
  templateId?: string;
  modifications?: Modifications;
  response?: Pick<RenderOptions, 'format' | 'scale' | 'quality' | 'includePages'>;
  renderId?: string;
  mediaUrls?: string[];
  accounts?: SocialPostAccount[];
  caption?: string;
  captions?: Partial<Record<SocialPlatform, string>>;
  options?: SocialPostOptions;
  /** ISO 8601; without an offset it is read in `timezone`. Omit to post now. */
  scheduledAt?: string;
  /** IANA time zone (default UTC). */
  timezone?: string;
  draft?: boolean;
}

export interface SocialMedia {
  kind: 'image' | 'video' | 'pdf';
  contentType: string;
  /** A rendered file is a fresh link on every read that works for an hour (`expiresAt`). */
  url: string;
  expiresAt?: string;
  bytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  pages?: number;
}

export type SocialTargetStatus =
  | 'draft'
  | 'queued'
  | 'rendering'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'canceled';

export interface SocialPostTarget {
  id: string;
  accountId?: string | null;
  platform: SocialPlatform;
  accountName: string;
  status: SocialTargetStatus;
  caption: string;
  permalink?: string | null;
  externalId?: string | null;
  error?: { kind: 'auth' | 'transient' | 'permanent' | 'validation'; code: string; message: string } | null;
  warnings: string[];
  attempts: number;
  nextAttemptAt?: string | null;
  publishedAt?: string | null;
}

export type SocialPostStatus =
  | 'draft'
  | 'scheduled'
  | 'queued'
  | 'rendering'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'canceled';

export interface SocialPost {
  id: string;
  status: SocialPostStatus;
  caption: string;
  captions?: Record<string, string>;
  options?: Record<string, unknown>;
  media?: SocialMedia[] | null;
  mediaSource?: Record<string, unknown>;
  renderJobId?: string | null;
  renderId?: string | null;
  scheduledAt?: string | null;
  timezone?: string | null;
  source?: 'app' | 'api' | 'mcp';
  error?: ApiErrorBody | null;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string | null;
  targets: SocialPostTarget[];
}

export interface SocialIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface SocialTargetIssues {
  accountId: string;
  platform: SocialPlatform;
  accountName: string;
  errors: SocialIssue[];
  warnings: SocialIssue[];
}

export interface SocialPostCreated {
  post: SocialPost;
  /** Accounts with warnings (and, for drafts, the errors to fix). */
  checks: SocialTargetIssues[];
}

export interface SocialPostPage {
  posts: SocialPost[];
  pagination: Pagination;
}

export interface ListSocialPostsParams extends PageParams {
  /** `queue`, `drafts`, `published`, `attention`, `canceled` or a post status. */
  status?: string;
}

export interface SocialPostEvent {
  post: SocialPost;
  target: SocialPostTarget;
}

// ---------------------------------------------------------------- social analytics

export type SocialMetricName =
  | 'impressions'
  | 'reach'
  | 'likes'
  | 'comments'
  | 'shares'
  | 'saves'
  | 'clicks'
  | 'engagement';

/**
 * Metrics; `null` when the platform doesn't report one. `impressions` holds
 * impressions or views; `engagement` is likes + comments + shares + saves.
 */
export type SocialMetricValues = Record<SocialMetricName, number | null>;

/** The days asked for, in the organization's analytics time zone. */
export interface SocialAnalyticsParams {
  /** First day, `YYYY-MM-DD` (default 27 days before `to`). */
  from?: string;
  /** Last day, included (default today). A range is at most 366 days. */
  to?: string;
  /** Only these platforms. */
  platform?: SocialPlatform | SocialPlatform[];
  /** Only these accounts (ids from `social.accounts.list()`). */
  accountId?: string | string[];
}

export interface SocialAnalyticsRange {
  from: string;
  to: string;
  days: number;
  timezone: string;
  /** Days of history the plan keeps. */
  historyDays: number;
  /** The range started before the plan's history; `from` was moved up. */
  limited: boolean;
}

export interface SocialAnalyticsOverview {
  range: SocialAnalyticsRange;
  previousRange: { from: string; to: string };
  /** The metrics the platforms in scope report. */
  available: SocialMetricName[];
  totals: SocialMetricValues;
  previous: SocialMetricValues;
  /** Percent change from `previous` to `totals`. */
  change: SocialMetricValues;
  /** Engagement ÷ impressions, in percent. */
  engagementRate: number | null;
  postsPublished: number;
  previousPostsPublished: number;
}

export interface SocialAnalyticsDay extends SocialMetricValues {
  day: string;
  postsPublished: number;
}

export interface SocialAnalyticsDaily {
  range: SocialAnalyticsRange;
  available: SocialMetricName[];
  /** Oldest first. */
  days: SocialAnalyticsDay[];
}

/** One post on one account and its lifetime numbers so far. */
export interface SocialPostMetrics {
  id: string;
  accountId: string;
  accountName: string;
  platform: SocialPlatform;
  platformName?: string;
  /** The platform's post id. */
  externalId: string;
  /** The post (`social.posts.get()`) when it was made here. */
  postId?: string | null;
  origin: 'app' | 'imported';
  permalink?: string | null;
  caption: string;
  mediaType?: string | null;
  thumbnailUrl?: string | null;
  publishedAt: string;
  metrics: SocialMetricValues;
  engagementRate?: number | null;
  /** `done`: past 90 days; `unavailable`: no numbers from the platform; `gone`: deleted there. */
  status: 'active' | 'done' | 'unavailable' | 'gone';
  statusReason?: string | null;
  lastFetchedAt?: string | null;
}

export interface SocialAnalyticsInsights {
  range: SocialAnalyticsRange;
  topPosts: SocialPostMetrics[];
  bestTimes: {
    basedOnPosts: number;
    /** At least 5 posts with numbers. */
    enoughData: boolean;
    metric: 'engagement' | 'impressions';
    timezone: string;
    /** Sunday (0) to Saturday (6). */
    weekdays: { weekday: number; name: string; posts: number; average: number | null }[];
    /** 0 to 23. */
    hours: { hour: number; posts: number; average: number | null }[];
    bestWeekday: { weekday: number; name: string } | null;
    bestHour: number | null;
  };
  platforms: {
    platform: SocialPlatform;
    platformName: string;
    posts: number;
    totals: SocialMetricValues;
    averages: SocialMetricValues;
    engagementRate: number | null;
  }[];
}

// ---------------------------------------------------------------- AI

export interface AiStatus {
  /** `live`: AI runs. `mock`: a development server's placeholder output. `off`: AI calls answer `503 AI_UNAVAILABLE`. */
  status: 'live' | 'mock' | 'off';
  /** The model each AI task uses (design, fast, vision, image, imageEdit, background, tts, stt, video, embedding). */
  models: Record<string, string>;
  /** An operation costs `credits` per started block of `per` units. */
  prices: {
    operation:
      | 'text'
      | 'design'
      | 'vision'
      | 'image'
      | 'image_hd'
      | 'background_local'
      | 'background_model'
      | 'tts'
      | 'stt'
      | 'video'
      | 'embedding';
    credits: number;
    per: number;
    unit: 'word' | 'call' | 'image' | 'character' | 'second' | 'input';
    label: string;
  }[];
  /** The organization's AI credits this billing period (`null`: unlimited). */
  credits: {
    planCode: string;
    used: number;
    /** Held by AI calls still running. */
    reserved: number;
    limit: number | null;
    remaining: number | null;
    periodStart: string;
    periodEnd: string;
    /** False when the subscription isn't active. */
    active: boolean;
  };
}

/** A file in the workspace's brand library. */
export interface BrandAsset {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'font' | 'color';
  name: string;
  url: string;
  mimeType?: string | null;
  size?: number | null;
  createdAt?: string;
  tags: string[];
  /** `width`, `height` (images, videos), `duration` (videos, audio). */
  meta?: Record<string, unknown> | null;
}

/** A file to upload: a Blob or File, a Buffer, a Uint8Array or an ArrayBuffer. */
export type FileInput = Blob | ArrayBuffer | ArrayBufferView;

/** A public URL, or a file to upload (with an optional file name). */
export type MediaSource = { url: string; file?: never } | { file: FileInput; filename?: string; url?: never };

/** The picture (PNG, JPEG, GIF or WebP up to 10 MB). */
export type RemoveBackgroundInput = MediaSource & {
  /** Name of the new brand-library asset (default: the file name or "Image"), suffixed "(no background)". */
  name?: string;
};

/** The cut-out, stored in the brand library as a transparent PNG. */
export interface BackgroundRemoval {
  /** The PNG's URL, ready for an image parameter in `modifications`. */
  url: string;
  width?: number | null;
  height?: number | null;
  /** `local`: original pixels kept (1 AI credit). `model`: an image model redrew the subject. */
  method: 'local' | 'model';
  model: string;
  /** Cut out smaller than the picture (over 4096 px a side, or over 10 MB as PNG). */
  scaled: boolean;
  creditsCharged: number;
  asset: BrandAsset;
}

export interface TranscribeOptions {
  /** ISO-639-1 code such as `en`; detected when omitted. */
  language?: string;
  /** `standard`: up to 2 lines of 42 characters. `short`: one line of up to 24. */
  style?: 'standard' | 'short';
  maxCharsPerLine?: number;
  maxLines?: number;
  /** Seconds into the file to start from. */
  start?: number;
  /** Seconds to transcribe (default: to the end). */
  duration?: number;
  /** Seconds added to every cue (where `start` lands on your video). */
  offset?: number;
  /** Include the word timestamps. */
  words?: boolean;
}

/** The audio (MP3, M4A, WAV, Ogg) or video (MP4, WebM) with sound, up to 100 MB. */
export type TranscribeInput = TranscribeOptions & MediaSource;

export interface Transcription {
  language?: string | null;
  /** Seconds of audio transcribed. */
  duration: number;
  text: string;
  /** Pass as `modifications.subtitles` in an MP4 render. */
  cues: SubtitleCue[];
  srt: string;
  vtt: string;
  words?: { word: string; start: number; end: number }[];
  creditsCharged: number;
  model?: string;
  mock?: boolean;
}

// ---------------------------------------------------------------- workflows

/** A stored secret, shown masked. Send it back to keep the value, or `""` to clear it. */
export interface WorkflowSecret {
  set: true;
  tail?: string;
}

/**
 * A workflow's steps (version 1): a trigger, a row source, transforms, the
 * render and deliveries. The fields of each kind of step are in the API
 * reference ("WorkflowDefinition").
 */
export interface WorkflowDefinition {
  version: 1;
  trigger: {
    kind: 'manual' | 'schedule' | 'webhook' | 'new_rows';
    frequency?: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
    minute?: number;
    time?: string;
    dayOfWeek?: number;
    dayOfMonth?: number;
    cron?: string;
    timezone?: string;
    intervalMinutes?: 15 | 30 | 60 | 180 | 360 | 720 | 1440;
  };
  source: {
    kind: 'google_sheets' | 'file_url' | 'airtable' | 'drive_folder' | 'webhook';
    [field: string]: unknown;
  };
  transforms?: { kind: 'filter' | 'sort' | 'limit' | 'pick' | 'dedupe'; [field: string]: unknown }[];
  action: {
    kind: 'render';
    templateId: string;
    /** Template parameter → value with `{{Column}}` placeholders. */
    mapping?: Record<string, string>;
    format?: OutputFormat;
    scale?: number;
    quality?: number;
    includePages?: number[];
  };
  deliver?: {
    kind: 'url' | 'webhook' | 'slack' | 'social' | 'sheets_writeback' | 'drive_upload' | 's3_upload';
    [field: string]: unknown;
  }[];
}

export interface WorkflowCreateInput {
  name?: string;
  description?: string | null;
  definition?: WorkflowDefinition;
  /** An Explore starter's id, e.g. `csv-quotes-webhook`. */
  starter?: string;
}

export interface WorkflowUpdateInput {
  name?: string;
  description?: string | null;
  definition?: WorkflowDefinition;
  /** `active` needs a complete definition; otherwise a 400 with `detail.problems`. */
  status?: 'draft' | 'active';
}

export interface WorkflowRunRequest {
  /** Rows for a webhook-payload source (an array of objects, or one object). */
  payload?: unknown;
  /** Render only the first N rows (a test run). */
  maxRows?: number;
}

export type WorkflowRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'canceled';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  trigger: 'manual' | 'schedule' | 'webhook' | 'new_rows' | 'api' | 'mcp';
  /** `succeeded`, `partial`, `failed` and `canceled` are final. */
  status: WorkflowRunStatus;
  rowsTotal: number;
  rowsSucceeded: number;
  rowsFailed: number;
  rowsSkipped: number;
  /** Render credits the run's renders cost. */
  credits: number;
  error?: { code: string; message: string } | null;
  warnings: string[];
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface WorkflowRunRow {
  index: number;
  status: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  values: Record<string, string>;
  /** Google Sheets row number. */
  rowNumber?: number | null;
  modifications?: Record<string, string> | null;
  renderId?: string | null;
  /** The row's files: fresh links on every read that work for an hour. */
  urls: string[];
  credits: number;
  deliveries: { stepId: string; kind: string; status: 'succeeded' | 'failed' | 'sandbox'; message?: string; url?: string }[];
  error?: { code: string; message: string } | null;
}

/** A run with each row's result (at most 1,000 rows). */
export interface WorkflowRunWithRows extends WorkflowRun {
  rows: WorkflowRunRow[];
}

export interface WorkflowRunPage {
  runs: WorkflowRun[];
  pagination: Pagination;
}

/** The `data` of `workflow.run.*` webhook events. */
export interface WorkflowRunEvent extends WorkflowRun {
  /** The workflow's name when the run ended. */
  workflowName: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  status: 'draft' | 'active';
  definition: WorkflowDefinition;
  /** Steps as the plan counts them. */
  steps: number;
  /** What stops it from running (empty when ready). */
  problems: { stepId: string; message: string }[];
  trigger: { kind: string; summary: string };
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRun?: WorkflowRun | null;
  /** The incoming webhook URL (webhook trigger only). Anyone with it can start runs. */
  webhookUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- webhooks

export type WebhookEventType =
  | 'design.created'
  | 'design.updated'
  | 'design.deleted'
  | 'render.completed'
  | 'render.failed'
  | 'social.post.published'
  | 'social.post.failed'
  | 'workflow.run.completed'
  | 'workflow.run.failed';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'design.created',
  'design.updated',
  'design.deleted',
  'render.completed',
  'render.failed',
  'social.post.published',
  'social.post.failed',
  'workflow.run.completed',
  'workflow.run.failed',
];

export interface WebhookSubscription {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** `suspended` after 20 failed deliveries in a row; `revoked` once its creator lost access (create a new one). */
  status: 'active' | 'suspended' | 'revoked';
  /** Last 4 characters of the signing secret. */
  secretTail: string;
  failureCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscriptionInput {
  url: string;
  events: WebhookEventType[];
}

export interface WebhookSubscriptionWithSecret {
  subscription: WebhookSubscription;
  /** Shown once: store it to verify deliveries. */
  signingSecret: string;
}

export interface WebhookSubscriptionPage {
  subscriptions: WebhookSubscription[];
  pagination: Pagination;
}

interface WebhookEventBase<T extends WebhookEventType, D> {
  /** Event id (`whe_…`), shared by every subscription that receives it. */
  id: string;
  type: T;
  createdAt: string;
  data: D;
}

export type DesignWebhookEvent = WebhookEventBase<'design.created' | 'design.updated' | 'design.deleted', Design>;
export type RenderWebhookEvent = WebhookEventBase<'render.completed' | 'render.failed', RenderJob>;
export type SocialWebhookEvent = WebhookEventBase<'social.post.published' | 'social.post.failed', SocialPostEvent>;
export type WorkflowRunWebhookEvent = WebhookEventBase<'workflow.run.completed' | 'workflow.run.failed', WorkflowRunEvent>;

/** Body of every webhook delivery; narrow on `type`. */
export type WebhookEvent = DesignWebhookEvent | RenderWebhookEvent | SocialWebhookEvent | WorkflowRunWebhookEvent;

export interface WebhookTestResult {
  delivery: { id: string; eventType: WebhookEventType; createdAt: string };
  sample: WebhookEvent;
}

/**
 * Checks the SDK against the API's OpenAPI spec (spec/openapi.yaml, or the
 * file named by JAMFRAME_SPEC_FILE), so the SDK can't quietly fall behind:
 *
 * - every endpoint is wrapped by a method, or skipped on purpose below;
 * - every enum value the API sends or accepts is in the SDK's types;
 * - the main types have exactly the spec's fields.
 *
 * The type lists are checked twice: by tsc (each list must name every key of
 * its type, and only those) and here (each list must equal the spec).
 * `npm run spec:update` downloads the live spec.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { Client, WEBHOOK_EVENT_TYPES } from '../src/index.js';
import type * as T from '../src/index.js';
import { startMockServer, type MockServer } from './mock-server.js';

type Schema = Record<string, any>;

const specFile = process.env.JAMFRAME_SPEC_FILE ?? new URL('../spec/openapi.yaml', import.meta.url);
const spec = parse(readFileSync(specFile, 'utf8')) as Schema;

function deref(schema: Schema): Schema {
  if (typeof schema?.$ref !== 'string') return schema;
  const name = schema.$ref.replace('#/components/schemas/', '');
  const target = spec.components.schemas[name];
  assert.ok(target, `unknown $ref ${schema.$ref}`);
  return deref(target);
}

/** The schema's parts: itself, its `allOf`/`oneOf`/`anyOf` options and, for an array, its items. */
function parts(schema: Schema): Schema[] {
  const s = deref(schema);
  return [s, ...[...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.items ? [s.items] : [])].flatMap(parts)];
}

/** `RenderOptions.cmyk.profile` → that schema, through `$ref`, `allOf`, `oneOf` and array items. */
function at(pointer: string): Schema {
  const [name, ...path] = pointer.split('.');
  let schema = spec.components.schemas[name!];
  assert.ok(schema, `no schema ${name} in the spec`);
  for (const key of path) {
    const found = parts(schema).find((p) => p.properties?.[key])?.properties[key];
    assert.ok(found, `no field ${key} in ${pointer}`);
    schema = found;
  }
  return deref(schema);
}

const fieldsAt = (pointer: string) =>
  [...new Set(parts(at(pointer)).flatMap((p) => Object.keys(p.properties ?? {})))].sort();

function enumAt(pointer: string): string[] {
  const values = parts(at(pointer)).flatMap((p) => p.enum ?? []);
  assert.ok(values.length, `no enum at ${pointer}`);
  return [...new Set(values.map(String))].sort();
}

/** Every key of `T`, and only those (else a type error naming the missing ones). */
const fieldsOf =
  <O>() =>
  <const K extends readonly (keyof O & string)[]>(
    keys: K & ([Exclude<keyof O, K[number]>] extends [never] ? unknown : { missing: Exclude<keyof O, K[number]> }),
  ): string[] =>
    [...keys].sort();

/** Every member of the string union `U`, and only those. */
const membersOf =
  <U extends string>() =>
  <const K extends readonly U[]>(
    values: K & ([Exclude<U, K[number]>] extends [never] ? unknown : { missing: Exclude<U, K[number]> }),
  ): string[] =>
    [...values].sort();

type Opt<X> = NonNullable<X>;

describe('the SDK matches the API spec', () => {
  describe('fields', () => {
    const cases: [string, string[]][] = [
      // requests
      ['RenderRequest', fieldsOf<T.RenderRequest>()(['templateId', 'modifications', 'response', 'async', 'webhookUrl', 'expiresIn', 'translate', 'lang', 'ai'])],
      ['RenderRequest.ai', fieldsOf<Opt<T.RenderRequest['ai']>>()(['onError'])],
      ['RenderOptions', fieldsOf<T.RenderOptions>()(['type', 'format', 'scale', 'quality', 'includePages', 'size', 'sizes', 'subtitles', 'cmyk', 'compress'])],
      ['SignedUrlRequest', fieldsOf<T.SignedUrlRequest>()(['templateId', 'modifications', 'response', 'expiresIn', 'cacheSeconds'])],
      ['SignedUrlRequest.response', fieldsOf<Opt<T.SignedUrlRequest['response']>>()(['format', 'scale', 'quality', 'includePages', 'size'])],
      ['SocialPostInput', fieldsOf<T.SocialPostInput>()(['templateId', 'modifications', 'response', 'renderId', 'mediaUrls', 'accounts', 'caption', 'captions', 'options', 'scheduledAt', 'timezone', 'draft'])],
      ['SocialPostInput.response', fieldsOf<Opt<T.SocialPostInput['response']>>()(['format', 'scale', 'quality', 'includePages'])],
      ['SocialPostInput.options', fieldsOf<T.SocialPostOptions>()(['instagram', 'facebook', 'linkedin', 'linkedin_page', 'x', 'tiktok', 'youtube', 'pinterest', 'bluesky', 'buffer'])],
      ['SocialPostInput.options.instagram', fieldsOf<Opt<T.SocialPostOptions['instagram']>>()(['shareToFeed'])],
      ['SocialPostInput.options.facebook', fieldsOf<Opt<T.SocialPostOptions['facebook']>>()(['title'])],
      ['SocialPostInput.options.tiktok', fieldsOf<T.TikTokPostOptions>()(['draft', 'privacyLevel', 'allowComment', 'allowDuet', 'allowStitch', 'commercialContent', 'yourBrand', 'brandedContent', 'aiGenerated', 'title', 'autoAddMusic', 'videoCoverTimestampMs'])],
      ['SocialPostInput.options.youtube', fieldsOf<T.YouTubePostOptions>()(['title', 'privacy', 'madeForKids', 'tags', 'categoryId', 'aiGenerated'])],
      ['SocialPostInput.options.pinterest', fieldsOf<T.PinterestPostOptions>()(['boardId', 'title', 'link', 'altText'])],
      ['SocialPostInput.options.bluesky', fieldsOf<T.BlueskyPostOptions>()(['altText'])],
      ['SocialPostInput.options.buffer', fieldsOf<T.BufferPostOptions>()(['mode', 'instagramType', 'facebookType', 'pinterestBoardId', 'title', 'link', 'youtubeCategoryId'])],
      ['LinkedInPostOptions', fieldsOf<T.LinkedInPostOptions>()(['firstComment', 'documentTitle', 'visibility'])],
      ['DesignGenerateRequest', fieldsOf<T.DesignGenerateRequest>()(['prompt', 'size', 'width', 'height', 'pages', 'video', 'brand', 'referenceImageUrl', 'name', 'async', 'webhookUrl'])],
      ['DesignGenerateRequest.brand', fieldsOf<Exclude<T.DesignGenerateRequest['brand'], boolean | undefined>>()(['colors', 'fonts', 'logo'])],
      ['TranscribeRequest', fieldsOf<T.TranscribeOptions & { url: string }>()(['url', 'language', 'style', 'maxCharsPerLine', 'maxLines', 'start', 'duration', 'offset', 'words'])],
      ['WebhookSubscriptionInput', fieldsOf<T.WebhookSubscriptionInput>()(['url', 'events'])],
      ['WorkflowCreate', fieldsOf<T.WorkflowCreateInput>()(['name', 'description', 'definition', 'starter'])],
      ['WorkflowUpdate', fieldsOf<T.WorkflowUpdateInput>()(['name', 'description', 'definition', 'status'])],
      ['WorkflowRunRequest', fieldsOf<T.WorkflowRunRequest>()(['payload', 'maxRows'])],
      ['WorkflowDefinition', fieldsOf<T.WorkflowDefinition>()(['version', 'trigger', 'source', 'transforms', 'action', 'deliver'])],
      ['WorkflowDefinition.trigger', fieldsOf<T.WorkflowDefinition['trigger']>()(['kind', 'frequency', 'minute', 'time', 'dayOfWeek', 'dayOfMonth', 'cron', 'timezone', 'intervalMinutes'])],
      ['WorkflowDefinition.action', fieldsOf<T.WorkflowDefinition['action']>()(['kind', 'templateId', 'mapping', 'format', 'scale', 'quality', 'includePages'])],
      // responses
      ['ApiError', fieldsOf<T.ApiErrorBody>()(['error', 'message', 'detail'])],
      ['AuthResult', fieldsOf<T.AuthResult>()(['workspaceId', 'username'])],
      ['Pagination', fieldsOf<T.Pagination>()(['nextCursor', 'hasMore'])],
      ['Design', fieldsOf<T.Design>()(['id', 'name', 'orientation', 'pages', 'animated', 'createdAt', 'updatedAt'])],
      ['DesignDetail', fieldsOf<T.DesignDetail>()(['id', 'name', 'orientation', 'pages', 'animated', 'createdAt', 'updatedAt', 'parameters', 'sizes'])],
      ['TemplateParameter', fieldsOf<T.TemplateParameter>()(['key', 'type', 'pages', 'example', 'prompt'])],
      ['TemplateSize', fieldsOf<T.TemplateSize>()(['id', 'name', 'width', 'height'])],
      ['DesignGenerateJob', fieldsOf<T.DesignGenerateJob>()(['jobId', 'status', 'design', 'message', 'changes', 'creditsCharged', 'mock', 'error', 'createdAt', 'finishedAt'])],
      ['DesignGenerateJob.design', fieldsOf<T.GeneratedDesign>()(['id', 'name', 'orientation', 'pages', 'animated', 'createdAt', 'updatedAt', 'parameters', 'sizes', 'editorUrl'])],
      ['DesignGenerateCallback', fieldsOf<T.DesignGenerateCallback>()(['event', 'job'])],
      ['RenderResult', fieldsOf<T.RenderResult>()(['content', 'urls', 'expiresAt', 'type', 'format', 'pages', 'credits', 'renderId', 'responseTime', 'duration', 'subtitles', 'aiCredits'])],
      ['SizedContent', fieldsOf<T.SizedContent>()(['size', 'name', 'width', 'height', 'pages', 'url', 'urls'])],
      ['RenderJob', fieldsOf<T.RenderJob>()(['id', 'status', 'progress', 'format', 'templateId', 'createdAt', 'startedAt', 'finishedAt', 'result', 'error', 'warnings'])],
      ['RenderJobCallback', fieldsOf<T.RenderJobCallback>()(['event', 'job'])],
      ['RenderItem', fieldsOf<T.RenderItem>()(['id', 'createdAt', 'designId', 'designName', 'source', 'format', 'pages', 'credits', 'status', 'durationMs', 'outputs', 'error', 'cached'])],
      ['RenderOutputFile', fieldsOf<T.RenderOutputFile>()(['url', 'page', 'expiresAt'])],
      ['RenderTotals', fieldsOf<T.RenderTotals>()(['periodStart', 'periodEnd', 'creditsUsed', 'creditsQuota', 'creditsRemaining', 'workspaceCreditsUsed'])],
      ['SignedUrlResponse', fieldsOf<T.SignedUrlResponse>()(['data', 'warnings'])],
      ['SignedUrlResponse.data', fieldsOf<T.SignedUrlResponse['data']>()(['url', 'templateId', 'format', 'expiresAt'])],
      ['SocialAccount', fieldsOf<T.SocialAccount>()(['id', 'platform', 'platformName', 'name', 'username', 'avatarUrl', 'status', 'statusReason', 'sandbox', 'reconnectBy', 'createdAt', 'lastPostedAt'])],
      ['SocialMedia', fieldsOf<T.SocialMedia>()(['kind', 'contentType', 'url', 'expiresAt', 'bytes', 'width', 'height', 'durationSec', 'pages'])],
      ['SocialPostTarget', fieldsOf<T.SocialPostTarget>()(['id', 'accountId', 'platform', 'accountName', 'status', 'caption', 'permalink', 'externalId', 'error', 'warnings', 'attempts', 'nextAttemptAt', 'publishedAt'])],
      ['SocialPost', fieldsOf<T.SocialPost>()(['id', 'status', 'caption', 'captions', 'options', 'media', 'mediaSource', 'renderJobId', 'renderId', 'scheduledAt', 'timezone', 'source', 'error', 'createdAt', 'updatedAt', 'finishedAt', 'targets'])],
      ['SocialTargetIssues', fieldsOf<T.SocialTargetIssues>()(['accountId', 'platform', 'accountName', 'errors', 'warnings'])],
      ['SocialIssue', fieldsOf<T.SocialIssue>()(['level', 'code', 'message'])],
      ['SocialPostEvent', fieldsOf<T.SocialPostEvent>()(['post', 'target'])],
      ['SocialAnalyticsRange', fieldsOf<T.SocialAnalyticsRange>()(['from', 'to', 'days', 'timezone', 'historyDays', 'limited'])],
      ['SocialAnalyticsOverview', fieldsOf<T.SocialAnalyticsOverview>()(['range', 'previousRange', 'available', 'totals', 'previous', 'change', 'engagementRate', 'postsPublished', 'previousPostsPublished'])],
      ['SocialAnalyticsDaily', fieldsOf<T.SocialAnalyticsDaily>()(['range', 'available', 'days'])],
      ['SocialAnalyticsDaily.days', fieldsOf<T.SocialAnalyticsDay>()(['day', 'postsPublished', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'engagement'])],
      ['SocialPostMetrics', fieldsOf<T.SocialPostMetrics>()(['id', 'accountId', 'accountName', 'platform', 'platformName', 'externalId', 'postId', 'origin', 'permalink', 'caption', 'mediaType', 'thumbnailUrl', 'publishedAt', 'metrics', 'engagementRate', 'status', 'statusReason', 'lastFetchedAt'])],
      ['SocialAnalyticsInsights', fieldsOf<T.SocialAnalyticsInsights>()(['range', 'topPosts', 'bestTimes', 'platforms'])],
      ['SocialAnalyticsInsights.bestTimes', fieldsOf<T.SocialAnalyticsInsights['bestTimes']>()(['basedOnPosts', 'enoughData', 'metric', 'timezone', 'weekdays', 'hours', 'bestWeekday', 'bestHour'])],
      ['SocialAnalyticsInsights.platforms', fieldsOf<T.SocialAnalyticsInsights['platforms'][number]>()(['platform', 'platformName', 'posts', 'totals', 'averages', 'engagementRate'])],
      ['AiStatus', fieldsOf<T.AiStatus>()(['status', 'models', 'prices', 'credits'])],
      ['AiStatus.prices', fieldsOf<T.AiStatus['prices'][number]>()(['operation', 'credits', 'per', 'unit', 'label'])],
      ['AiStatus.credits', fieldsOf<T.AiStatus['credits']>()(['planCode', 'used', 'reserved', 'limit', 'remaining', 'periodStart', 'periodEnd', 'active'])],
      ['BackgroundRemoval', fieldsOf<T.BackgroundRemoval>()(['url', 'width', 'height', 'method', 'model', 'scaled', 'creditsCharged', 'asset'])],
      ['BrandAsset', fieldsOf<T.BrandAsset>()(['id', 'kind', 'name', 'url', 'mimeType', 'size', 'createdAt', 'tags', 'meta'])],
      ['Transcription', fieldsOf<T.Transcription>()(['language', 'duration', 'text', 'cues', 'srt', 'vtt', 'words', 'creditsCharged', 'model', 'mock'])],
      ['SubtitleCue', fieldsOf<T.SubtitleCue>()(['start', 'end', 'text'])],
      ['WebhookSubscription', fieldsOf<T.WebhookSubscription>()(['id', 'url', 'events', 'status', 'secretTail', 'failureCount', 'lastFiredAt', 'createdAt', 'updatedAt'])],
      ['Workflow', fieldsOf<T.Workflow>()(['id', 'name', 'description', 'status', 'definition', 'steps', 'problems', 'trigger', 'nextRunAt', 'lastRunAt', 'lastRun', 'webhookUrl', 'createdAt', 'updatedAt'])],
      ['WorkflowSecret', fieldsOf<T.WorkflowSecret>()(['set', 'tail'])],
      ['WorkflowRun', fieldsOf<T.WorkflowRun>()(['id', 'workflowId', 'trigger', 'status', 'rowsTotal', 'rowsSucceeded', 'rowsFailed', 'rowsSkipped', 'credits', 'error', 'warnings', 'createdAt', 'startedAt', 'finishedAt'])],
      ['WorkflowRunEvent', fieldsOf<T.WorkflowRunEvent>()(['id', 'workflowId', 'trigger', 'status', 'rowsTotal', 'rowsSucceeded', 'rowsFailed', 'rowsSkipped', 'credits', 'error', 'warnings', 'createdAt', 'startedAt', 'finishedAt', 'workflowName'])],
      ['WorkflowRunRow', fieldsOf<T.WorkflowRunRow>()(['index', 'status', 'values', 'rowNumber', 'modifications', 'renderId', 'urls', 'credits', 'deliveries', 'error'])],
    ];
    for (const [pointer, sdk] of cases) {
      it(pointer, () => assert.deepEqual(sdk, fieldsAt(pointer)));
    }
  });

  describe('enums', () => {
    const cases: [string, string[]][] = [
      ['ApiError.error', membersOf<T.ApiErrorCode>()(['MISSING_API_KEY', 'INVALID_API_KEY', 'EXPIRED_API_KEY', 'ORG_ON_HOLD', 'ORG_SUSPENDED', 'RATE_LIMITED', 'VALIDATION_ERROR', 'INVALID_REQUEST', 'BODY_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_FOUND', 'CONFLICT', 'QUOTA_EXCEEDED', 'WORKSPACE_QUOTA_EXCEEDED', 'PLAN_LIMIT_EXCEEDED', 'WEBHOOK_URL_INVALID', 'WEBHOOK_LIMIT_REACHED', 'VIDEO_UNAVAILABLE', 'AI_UNAVAILABLE', 'AI_CONTENT_REFUSED', 'AI_TIMEOUT', 'AI_RATE_LIMITED', 'AI_BAD_OUTPUT', 'AI_BAD_REQUEST', 'AI_UPSTREAM_ERROR', 'AI_CREDITS_EXCEEDED', 'INTERNAL'])],
      ['SocialPlatform', membersOf<T.SocialPlatform>()(['instagram', 'facebook', 'linkedin', 'linkedin_page', 'x', 'tiktok', 'youtube', 'pinterest', 'bluesky', 'buffer'])],
      ['WebhookEventType', membersOf<T.WebhookEventType>()(['design.created', 'design.updated', 'design.deleted', 'render.completed', 'render.failed', 'social.post.published', 'social.post.failed', 'workflow.run.completed', 'workflow.run.failed'])],
      ['WebhookSubscription.status', membersOf<T.WebhookSubscription['status']>()(['active', 'suspended', 'revoked'])],
      ['RenderOptions.format', membersOf<T.RenderFormat>()(['png', 'jpeg', 'jpg', 'webp', 'pdf', 'mp4'])],
      ['RenderResult.format', membersOf<T.OutputFormat>()(['png', 'jpeg', 'webp', 'pdf', 'mp4'])],
      ['RenderOptions.cmyk.profile', membersOf<T.CmykProfile>()(['fogra39', 'fogra51', 'fogra52', 'fogra47', 'fogra29', 'fogra40', 'fogra45', 'ifra26', 'gracol2013', 'gracol2013-uncoated', 'swop2013', 'japan2011', 'gracol2006'])],
      ['RenderOptions.compress.preset', membersOf<Opt<Exclude<T.RenderOptions['compress'], boolean | undefined>['preset']>>()(['ebook', 'screen', 'printer', 'prepress'])],
      ['RenderJob.status', membersOf<T.RenderJobStatus>()(['queued', 'running', 'succeeded', 'failed'])],
      ['RenderItem.source', membersOf<T.RenderItem['source']>()(['api', 'editor', 'signed-url', 'dynamic-url', 'form', 'workflow', 'shopify', 'webflow'])],
      ['TemplateParameter.type', membersOf<T.TemplateParameterType>()(['text', 'image', 'qr', 'shape', 'video', 'audio', 'subtitles', 'variable'])],
      ['DesignGenerateJob.status', membersOf<T.DesignGenerateJob['status']>()(['running', 'succeeded', 'failed'])],
      ['SocialPost.status', membersOf<T.SocialPostStatus>()(['draft', 'scheduled', 'queued', 'rendering', 'publishing', 'published', 'partial', 'failed', 'canceled'])],
      ['SocialPostTarget.status', membersOf<T.SocialTargetStatus>()(['draft', 'queued', 'rendering', 'publishing', 'published', 'failed', 'canceled'])],
      ['SocialPostInput.options.buffer.mode', membersOf<Opt<T.BufferPostOptions['mode']>>()(['queue', 'next', 'now', 'draft'])],
      ['SocialPostInput.options.tiktok.privacyLevel', membersOf<Opt<T.TikTokPostOptions['privacyLevel']>>()(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])],
      ['SocialMetricName', membersOf<T.SocialMetricName>()(['impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'engagement'])],
      ['SocialPostMetrics.status', membersOf<T.SocialPostMetrics['status']>()(['active', 'done', 'unavailable', 'gone'])],
      ['AiStatus.status', membersOf<T.AiStatus['status']>()(['live', 'mock', 'off'])],
      ['AiStatus.prices.operation', membersOf<T.AiStatus['prices'][number]['operation']>()(['text', 'design', 'vision', 'image', 'image_hd', 'background_local', 'background_model', 'tts', 'stt', 'video', 'embedding'])],
      ['BrandAsset.kind', membersOf<T.BrandAsset['kind']>()(['image', 'video', 'audio', 'font', 'color'])],
      ['WorkflowRun.status', membersOf<T.WorkflowRunStatus>()(['queued', 'running', 'succeeded', 'partial', 'failed', 'canceled'])],
      ['WorkflowRun.trigger', membersOf<T.WorkflowRun['trigger']>()(['manual', 'schedule', 'webhook', 'new_rows', 'api', 'mcp'])],
      ['WorkflowRunRow.status', membersOf<T.WorkflowRunRow['status']>()(['pending', 'running', 'succeeded', 'partial', 'failed', 'skipped'])],
      ['WorkflowDefinition.trigger.kind', membersOf<T.WorkflowDefinition['trigger']['kind']>()(['manual', 'schedule', 'webhook', 'new_rows'])],
      ['WorkflowDefinition.source.kind', membersOf<T.WorkflowDefinition['source']['kind']>()(['google_sheets', 'file_url', 'airtable', 'drive_folder', 'webhook'])],
      ['WorkflowDefinition.deliver.kind', membersOf<Opt<T.WorkflowDefinition['deliver']>[number]['kind']>()(['url', 'webhook', 'slack', 'social', 'sheets_writeback', 'drive_upload', 's3_upload'])],
    ];
    for (const [pointer, sdk] of cases) {
      it(pointer, () => assert.deepEqual(sdk, enumAt(pointer)));
    }

    it('WEBHOOK_EVENT_TYPES lists every event', () => {
      assert.deepEqual([...WEBHOOK_EVENT_TYPES].sort(), enumAt('WebhookEventType'));
    });
  });

  describe('endpoints', () => {
    // Not for API-key clients: the Figma plugin's import, and the public
    // links and forms that browsers open.
    const SKIPPED = new Set([
      'GET /designs/import/figma',
      'POST /designs/import/figma',
      'GET /r/s/{token}',
      'GET /r/d/{file}',
      'GET /api/public/forms/{publicId}',
      'POST /api/public/forms/{publicId}/render',
      'POST /api/public/forms/{publicId}/uploads',
      'GET /api/public/forms/{publicId}/files/{handle}',
    ]);

    // One call per endpoint. Answers don't matter: the mock answers 404.
    const CALLS: Record<string, (c: Client) => Promise<unknown>> = {
      'POST /auth': (c) => c.whoami(),
      'POST /render': (c) => c.render({ templateId: 't' }),
      'GET /render-jobs/{id}': (c) => c.renderJobs.get('j'),
      'GET /renders': (c) => c.renders.list(),
      'GET /renders/{id}': (c) => c.renders.get('r'),
      'POST /signed-urls': (c) => c.signedUrls.create({ templateId: 't' }),
      'POST /signed-urls/rotate-key': (c) => c.signedUrls.rotateKey(),
      'GET /designs': (c) => c.designs.list(),
      'GET /designs/{id}': (c) => c.designs.get('d'),
      'POST /designs/generate': (c) => c.designs.generate({ prompt: 'p' }),
      'GET /designs/generate/{jobId}': (c) => c.designJobs.get('j'),
      'GET /webhooks/subscriptions': (c) => c.webhooks.subscriptions.list(),
      'POST /webhooks/subscriptions': (c) => c.webhooks.subscriptions.create({ url: 'https://x', events: ['render.completed'] }),
      'GET /webhooks/subscriptions/{id}': (c) => c.webhooks.subscriptions.get('s'),
      'DELETE /webhooks/subscriptions/{id}': (c) => c.webhooks.subscriptions.delete('s'),
      'POST /webhooks/subscriptions/{id}/test': (c) => c.webhooks.subscriptions.test('s'),
      'POST /webhooks/subscriptions/{id}/rotate-secret': (c) => c.webhooks.subscriptions.rotateSecret('s'),
      'GET /social/accounts': (c) => c.social.accounts.list(),
      'POST /social/posts': (c) => c.social.posts.create({ caption: 'c' }),
      'GET /social/posts': (c) => c.social.posts.list(),
      'GET /social/posts/{id}': (c) => c.social.posts.get('p'),
      'POST /social/posts/{id}/cancel': (c) => c.social.posts.cancel('p'),
      'POST /social/posts/{id}/retry': (c) => c.social.posts.retry('p'),
      'GET /social/analytics/overview': (c) => c.social.analytics.overview(),
      'GET /social/analytics/daily': (c) => c.social.analytics.daily(),
      'GET /social/analytics/insights': (c) => c.social.analytics.insights(),
      'GET /ai/status': (c) => c.ai.status(),
      'POST /images/remove-background': (c) => c.ai.removeBackground({ url: 'https://x/a.png' }),
      'POST /ai/transcribe': (c) => c.ai.transcribe({ url: 'https://x/a.mp3' }),
      'GET /workflows': (c) => c.workflows.list(),
      'POST /workflows': (c) => c.workflows.create(),
      'GET /workflows/{id}': (c) => c.workflows.get('w'),
      'PATCH /workflows/{id}': (c) => c.workflows.update('w', { name: 'n' }),
      'DELETE /workflows/{id}': (c) => c.workflows.delete('w'),
      'POST /workflows/{id}/run': (c) => c.workflows.run('w'),
      'POST /workflows/{id}/webhook-token': (c) => c.workflows.rotateWebhookUrl('w'),
      'GET /workflows/{id}/runs': (c) => c.workflows.runs.list('w'),
      'GET /workflows/{id}/runs/{runId}': (c) => c.workflows.runs.get('w', 'r'),
      'POST /workflows/{id}/runs/{runId}/cancel': (c) => c.workflows.runs.cancel('w', 'r'),
    };

    const operations = Object.entries(spec.paths as Record<string, Schema>).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );

    let server: MockServer;
    let client: Client;
    before(async () => {
      server = await startMockServer();
      client = new Client({ apiKey: 'jf_live_test', baseUrl: server.url, maxRetries: 0 });
    });
    after(() => server.close());

    it('every endpoint in the spec has a method (or is skipped on purpose)', () => {
      const missing = operations.filter((op) => !CALLS[op] && !SKIPPED.has(op));
      assert.deepEqual(missing, [], `endpoints without an SDK method: ${missing.join(', ')}`);
      const stale = Object.keys(CALLS).filter((op) => !operations.includes(op));
      assert.deepEqual(stale, [], `methods for endpoints the spec doesn't have: ${stale.join(', ')}`);
    });

    for (const [op, call] of Object.entries(CALLS)) {
      it(`${op} is the request its method sends`, async () => {
        server.reset();
        await call(client).catch(() => undefined);
        const [method, template] = op.split(' ') as [string, string];
        const pattern = new RegExp(`^/v1${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
        const sent = server.requests[0];
        assert.ok(sent, `${op}: nothing was sent`);
        assert.equal(sent.method, method);
        assert.match(sent.path, pattern);
      });
    }
  });
});

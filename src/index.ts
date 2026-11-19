/**
 * Node.js / TypeScript client for the JamFrame API (brand strings live in
 * brand.ts).
 */
import { Client } from './client.js';

export { Client, fileUrls } from './client.js';
export type {
  GenerateCallOptions,
  GenerateDesignParams,
  RenderCallOptions,
  RenderParams,
  WaitOptions,
  Ai,
  Designs,
  DesignJobs,
  Renders,
  RenderJobs,
  SignedUrls,
  Social,
  SocialAccounts,
  SocialAnalytics,
  SocialPosts,
  Webhooks,
  WebhookSubscriptions,
  Workflows,
  WorkflowRuns,
} from './client.js';
export { normalizeBaseUrl } from './core.js';
export type { ClientOptions, RequestOptions, RawResponse } from './core.js';
export * from './errors.js';
export * from './types.js';
export {
  DEFAULT_TOLERANCE_SECONDS,
  WEBHOOK_HEADERS,
  constructWebhookEvent,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhooks.js';
export type { HeaderSource, VerifyOptions } from './webhooks.js';
export { BRAND } from './brand.js';
export { VERSION } from './version.js';

/** The client under the product's name. A rename changes this line. */
export { Client as JamFrame };
export default Client;

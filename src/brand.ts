/**
 * Every brand-specific string in the SDK. A rename changes this file, `name`
 * in package.json, the `JamFrame` alias in index.ts and the README, nothing
 * else.
 */
export const BRAND = {
  /** Product name, used in messages. */
  name: 'JamFrame',
  /** Production API origin. The client appends `/v1`. */
  defaultBaseUrl: 'https://api.jamframe.com',
  /** Environment variable read when `apiKey` isn't passed. */
  apiKeyEnv: 'JAMFRAME_API_KEY',
  /** Environment variable read when `baseUrl` isn't passed. */
  baseUrlEnv: 'JAMFRAME_BASE_URL',
  /** Environment variables that switch the live smoke test on. */
  smokeApiKeyEnv: 'JAMFRAME_SMOKE_API_KEY',
  smokeBaseUrlEnv: 'JAMFRAME_SMOKE_BASE_URL',
  /** First token of the User-Agent header: `<prefix>/<version>`. */
  userAgentPrefix: 'jamframe-node',
} as const;

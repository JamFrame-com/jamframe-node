# jamframe (Node.js / TypeScript)

The Node.js and TypeScript client for the [JamFrame](https://jamframe.com)
API: render your templates to images, carousels, PDFs and MP4 videos, design
new templates with AI, run workflows, post to social accounts and read their
analytics, and verify webhooks.

- Node 18.17 or later. ESM, with TypeScript types.
- No runtime dependencies: native `fetch`, `node:crypto` for webhooks.
- Typed methods for every API-key endpoint, cursor iterators, typed errors.
- Retries 429s (honouring `Retry-After`) on every call, and 5xx answers and
  network errors on idempotent calls only.

API reference: [app.jamframe.com/docs/api](https://app.jamframe.com/docs/api)
(the OpenAPI spec is [app.jamframe.com/openapi.yaml](https://app.jamframe.com/openapi.yaml)).
The [Python SDK](https://github.com/JamFrame-com/jamframe-python) has the same surface.

## Install

```sh
npm install jamframe
```

## Quick start

Create an API key in the app under **Developers → API Keys** (`jf_live_…`).

```ts
import { JamFrame } from 'jamframe';

const client = new JamFrame({ apiKey: process.env.JAMFRAME_API_KEY });
// or: new JamFrame() reads JAMFRAME_API_KEY (and JAMFRAME_BASE_URL)

const { data, warnings } = await client.render({
  templateId: 'clx8m2k3p0001abcd1234efgh',
  modifications: { title: 'Summer sale ends Sunday', 'title.color': '#FF4D4F' },
  response: { format: 'png', scale: 2 },
});
console.log(data.content, data.credits, warnings);
```

`JamFrame` and `Client` are the same class (and the default export).

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `JAMFRAME_API_KEY` | Required. |
| `baseUrl` | `JAMFRAME_BASE_URL`, then `https://api.jamframe.com` | The API's origin or its root (`…/v1`); both work, and so does the older `https://app.jamframe.com/api/v1`. |
| `timeoutMs` | `120000` | Per request. A synchronous MP4 render can take 90 s. |
| `maxRetries` | `2` | See [Retries](#retries). |
| `maxRetryDelayMs` | `60000` | A longer `Retry-After` isn't waited for. |
| `fetch` | global `fetch` | Your own fetch (proxies, instrumentation). |
| `userAgent` | | Prepended to the `User-Agent`, e.g. `my-app/1.2`. |
| `defaultHeaders` | | Sent with every request. |

Every method takes `{ signal, timeoutMs, maxRetries }` as its last argument.

## Templates

```ts
// Your workspace's templates, newest first (one page).
const { designs, pagination } = await client.designs.list({ limit: 50 });

// Every template, page after page.
for await (const design of client.designs.iterate()) console.log(design.name);

// The template library (ready-made templates any workspace can render).
for await (const preset of client.designs.iterate({ source: 'library' })) console.log(preset.id, preset.name);

// A picker's search box: names containing the text, ignoring case (either source).
// Each design has its page count and `animated` (a video template: render it as mp4).
const { designs: reels } = await client.designs.list({ source: 'library', q: 'reel' });
reels.map((d) => `${d.name} · ${d.pages} page(s)${d.animated ? ' · video' : ''}`);

// What a template takes: parameters (keys for `modifications`), page count, saved sizes.
const design = await client.designs.get('clx8m2k3p0002abcd1234efgh');
design.parameters; // [{ key: 'title', type: 'text', pages: [1, 2, 3], example: '…' }, …]
design.sizes;      // [{ id: 'story', name: 'Story / Reel', width: 1080, height: 1920 }]
```

### Design a template with AI

```ts
// Waits for the design (usually 10–40 s); 15 to 30 AI credits, refunded if it fails.
const job = await client.designs.generate({
  prompt: 'Announce our summer sale, 30% off everything this weekend. Bold and playful.',
  size: 'instagram-portrait', // or 'linkedin-carousel' with pages: 5, or '1200x630'
  // brand: false, or { colors: ['#0b1f4d', '#ff6b5b'], fonts: ['Poppins'] }; default: your brand library
});
job.design.id;         // render it like any other template
job.design.parameters; // [{ key: 'title', … }, { key: 'photo', … }]
job.design.editorUrl;  // open it in the editor

// Or start it and come back later (pass webhookUrl to be called when it ends).
const { jobId } = await client.designs.generateAsync({ prompt: 'A teaser video for our app launch', video: true });
const done = await client.designJobs.wait(jobId);
```

A failed generation throws `DesignJobFailedError` (`.code`, `.message`, `.job`).

## Rendering

Modification keys: `title` sets every layer with that key and every
`{{title}}` placeholder; `page2@title` only on page 2; `title.color` (also
`.fontSize`, `.hidden`, `.fill`, `.opacity`, …) overrides a style; `audio`,
`audio.volume`, `subtitles` and `subtitles.style.<field>` change a video's
sound and subtitles. Keys that match nothing come back in `warnings`.

```ts
// A carousel: one URL per page.
const carousel = await client.render({
  templateId: 'clx8m2k3p0002abcd1234efgh',
  modifications: { title: '5 ways to brew better coffee', 'page2@title': '1. Grind just before brewing' },
  response: { format: 'jpeg', quality: 90 },
});
carousel.data.content; // ['https://…-p1.jpg', 'https://…-p2.jpg', 'https://…-p3.jpg']

// A library template by its slug, as a PDF of pages 1 and 2, with links that work for an hour.
await client.render({ templateId: 'tool-quote-card-paper', response: { format: 'pdf', includePages: [1, 2] }, expiresIn: 3600 });

// Smart Resize: one size …
await client.render({ templateId, response: { format: 'png', size: 'story' } });
// … or several in one call (content is one entry per size).
const sized = await client.render({ templateId, response: { format: 'png', sizes: ['original', 'story', '1200x630'] } });
sized.data.content; // [{ size: 'original', width, height, url }, { size: 'story', … }, …]
sized.data.urls;    // every file's link in one list

// Translate every text layer with AI (AI credits; cached per text and language).
await client.render({ templateId, translate: true, lang: 'es', ai: { onError: 'fallback' } });

// Any content shape, flattened to a list of URLs.
import { fileUrls } from 'jamframe';
fileUrls(sized.data.content);
```

Credits: 1 per image or PDF page (per size with `sizes`), 1 per second of
video, charged only when the render succeeds. File links work for
`expiresIn` seconds (5 minutes by default, at most 7 days; `data.expiresAt`
says until when).

**Experimental, PDF only:** `response.cmyk` (`true`, or `{ profile: 'gracol2013' }`)
converts the colours to CMYK for print, and `response.compress` (`true`, or
`{ preset: 'printer' }`) makes the file smaller. Their options and output may
still change.

### Videos and render jobs

```ts
// Simplest: render() waits. The API answers an MP4 within 90 s, or hands
// back a job, which render() then polls (up to waitTimeoutMs).
const video = await client.render(
  { templateId, modifications: { audio: 'https://example.com/upbeat.mp3', 'audio.volume': 0.6 }, response: { format: 'mp4' } },
  { waitTimeoutMs: 10 * 60_000, onProgress: (job) => console.log(job.progress) },
);
video.data.content;  // the MP4 URL
video.data.duration; // seconds

// Queue it and get the job id at once …
const { jobId } = await client.renderAsync({
  templateId,
  response: { format: 'mp4', subtitles: 'vtt' },
  webhookUrl: 'https://hooks.example.com/render-done', // optional callback when it ends
});

// … poll it yourself …
const job = await client.renderJobs.get(jobId);

// … or wait for it (polls after 1 s, then 1.5× longer each time, at most 5 s apart).
const done = await client.renderJobs.wait(jobId, { timeoutMs: 10 * 60_000 });
done.result.content;

// Queue and wait in one call.
const finished = await client.renderAndWait({ templateId, response: { format: 'png' } });
```

A failed job throws `RenderJobFailedError` (`.code`, `.message`, `.job`; it
cost nothing). Waiting longer than `timeoutMs` throws `WaitTimeoutError`
(`.jobId`, `.lastJob`); the job keeps running and can be waited on again.

The `webhookUrl` callback is not signed: treat it as a hint and fetch the
job with your key, or subscribe to the signed `render.completed` and
`render.failed` events instead (see [Webhooks](#webhooks)).

## Render log

```ts
const { renders, totals } = await client.renders.list({ status: 'failed', designId: templateId, limit: 20 });
totals.creditsRemaining; // this period, null when unlimited
for await (const render of client.renders.iterate()) console.log(render.id, render.outputs);

// One render by id (the `renderId` of a render, or of a job's `result`).
const render = await client.renders.get(data.renderId);
render.status, render.credits, render.outputs; // [{ url, page, expiresAt }, …]
```

## Signed URLs

```ts
const signed = await client.signedUrls.create({
  templateId,
  modifications: { title: 'How we cut render times in half' },
  response: { format: 'png' },
  expiresIn: 30 * 24 * 3600,
});
signed.data.url; // https://api.jamframe.com/r/s/….png: renders when opened, cached afterwards

await client.signedUrls.rotateKey(); // every signed URL made so far stops working
```

## Workflows

Workflows render a template for each row of a Google Sheet, a CSV or XLSX
file, an Airtable table or a webhook, and deliver the files. Build them in
the app (or with `workflows.create()`), then run them from code.

```ts
const workflows = await client.workflows.list();

// Run one and wait for it to end; each row costs render credits.
const run = await client.workflows.runAndWait(workflows[0]!.id, { maxRows: 2 }); // a test run
run.status;                       // 'succeeded', 'partial', 'failed' or 'canceled' (check it: a failed run doesn't throw)
run.rows.map((row) => row.urls);  // each row's files

// A webhook-payload source: send the rows yourself.
await client.workflows.run(workflowId, { payload: [{ Quote: 'Stay curious', Author: 'Ada' }] });

for await (const r of client.workflows.runs.iterate(workflowId)) console.log(r.id, r.status);
await client.workflows.runs.cancel(workflowId, runId);
await client.workflows.update(workflowId, { status: 'active' }); // turns on its schedule or trigger
```

## Social posts

Accounts are connected in the app, which shows the networks you can
connect. Posting costs no credits; a template render costs the usual credits.

```ts
const accounts = await client.social.accounts.list();
const linkedin = accounts.find((a) => a.platform === 'linkedin' && a.status === 'active');

const { post, checks } = await client.social.posts.create({
  templateId,
  modifications: { title: 'Spring sale' },
  response: { format: 'jpeg' },
  accounts: [linkedin!.id],
  caption: 'Spring sale starts today #sale',
  scheduledAt: '2026-11-10T09:00',
  timezone: 'Europe/Paris',
  // options: { pinterest: { boardId, link }, tiktok: { draft: true }, buffer: { mode: 'next' } }
});

const latest = await client.social.posts.get(post.id);
latest.targets.map((t) => [t.platform, t.status, t.permalink]);

await client.social.posts.cancel(post.id);
await client.social.posts.retry(post.id); // or { targetId } for one account
for await (const p of client.social.posts.iterate({ status: 'attention' })) console.log(p.id);
```

If any account can't take the post, nothing is created and a
`BadRequestError` lists every problem in `err.detail.targets`.

### Analytics

```ts
const range = { from: '2026-10-01', to: '2026-10-31', platform: ['instagram', 'linkedin'] };
const overview = await client.social.analytics.overview(range);
overview.totals.impressions, overview.change.engagement; // change in % from the period before
const { days } = await client.social.analytics.daily(range);
const { topPosts, bestTimes } = await client.social.analytics.insights(range);
bestTimes.bestWeekday?.name, bestTimes.bestHour;
```

A metric is `null` when the platforms in scope don't report it.

## AI tools

```ts
// Cut the subject out of a picture (a URL or a file); a transparent PNG in your brand library. 1 AI credit.
import { readFile } from 'node:fs/promises';
const cutout = await client.ai.removeBackground({ file: await readFile('product.jpg'), filename: 'product.jpg' });
await client.render({ templateId, modifications: { photo: cutout.url } });

// Subtitles from speech (a URL or a file, up to 100 MB). 1 AI credit per minute of audio.
const subs = await client.ai.transcribe({ url: 'https://example.com/voiceover.mp3', style: 'short' });
await client.render({ templateId, modifications: { subtitles: subs.cues }, response: { format: 'mp4' } });

// Whether AI is available, the prices and your AI credits this period. Free.
const { credits } = await client.ai.status();
```

`file` takes a `Buffer`, a `Uint8Array`, an `ArrayBuffer` or a `Blob`/`File`.

## Webhooks

```ts
const { subscription, signingSecret } = await client.webhooks.subscriptions.create({
  url: 'https://example.com/jamframe-webhook',
  events: ['render.completed', 'render.failed', 'social.post.published', 'workflow.run.completed'],
});
// Store signingSecret now: it is shown once. rotateSecret(id) issues a new one.
await client.webhooks.subscriptions.test(subscription.id, 'render.completed');
await client.webhooks.subscriptions.delete(subscription.id);
```

Verify deliveries against the **raw** body (re-serialised JSON has different
bytes). With Express:

```ts
import express from 'express';
import { constructWebhookEvent, WebhookSignatureError } from 'jamframe';

const app = express();
app.post('/jamframe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers, process.env.JAMFRAME_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return res.sendStatus(400);
    throw err;
  }
  // Deliveries are at-least-once: deduplicate on the X-Webhook-Delivery header.
  switch (event.type) {
    case 'render.completed':
      console.log(event.data.result?.content);
      break;
    case 'social.post.published':
      console.log(event.data.target.permalink);
      break;
    case 'workflow.run.completed':
      console.log(event.data.workflowName, event.data.rowsSucceeded);
      break;
  }
  res.sendStatus(204);
});
```

`verifyWebhookSignature(rawBody, headersOrSignature, secret)` returns a
boolean instead. Both take the header value or the request's headers
(`Headers`, Node's `req.headers` or a plain object), a list of secrets while
you rotate, and `{ toleranceSeconds }` (default 300). `signWebhookPayload`
makes a signature for testing your endpoint.

## Errors

Every API error is an `APIError` with `status`, `code` (the envelope's
`error` field, e.g. `QUOTA_EXCEEDED`; also readable as `.error`), `message`
(safe to show) and `detail`:

| Status | Class | Codes |
| --- | --- | --- |
| 400 | `BadRequestError` | `VALIDATION_ERROR`, `INVALID_REQUEST`, `WEBHOOK_URL_INVALID` |
| 401 | `AuthenticationError` | `MISSING_API_KEY`, `INVALID_API_KEY`, `EXPIRED_API_KEY` |
| 402 | `PaymentRequiredError` | `QUOTA_EXCEEDED`, `WORKSPACE_QUOTA_EXCEEDED`, `AI_CREDITS_EXCEEDED`, `PLAN_LIMIT_EXCEEDED`, `WEBHOOK_LIMIT_REACHED` |
| 403 | `PermissionDeniedError` | `ORG_ON_HOLD`, `ORG_SUSPENDED` |
| 404 | `NotFoundError` | `NOT_FOUND` |
| 409 | `ConflictError` | `CONFLICT` |
| 422 | `UnprocessableEntityError` | a media or subtitle URL that won't load; `AI_CONTENT_REFUSED`, `AI_BAD_REQUEST` (nothing charged) |
| 429 | `RateLimitError` | `RATE_LIMITED`, `AI_RATE_LIMITED`; `.retryAfter` in seconds |
| 5xx | `InternalServerError` | `INTERNAL`, `AI_BAD_OUTPUT`, `AI_UPSTREAM_ERROR`, `AI_UNAVAILABLE`, `VIDEO_UNAVAILABLE`, `AI_TIMEOUT` (an error body that isn't JSON gives `HTTP_<status>`) |

Others: `APIConnectionError` (no answer), `APITimeoutError` (a subclass:
over `timeoutMs`), `RenderJobFailedError`, `DesignJobFailedError`,
`WaitTimeoutError`, `WebhookSignatureError`. All extend `SDKError`.

```ts
import { PaymentRequiredError } from 'jamframe';
try {
  await client.render({ templateId });
} catch (err) {
  if (err instanceof PaymentRequiredError) console.log('Out of credits:', err.detail);
  else throw err;
}
```

## Retries

- **429** is retried on every call, renders included: the API's rate
  limiter answers before anything runs. The client waits `Retry-After` (or
  the envelope's `detail.retryAfter`); if that's longer than
  `maxRetryDelayMs` it throws the `RateLimitError` instead.
- **5xx, network errors and timeouts** are retried only for idempotent
  calls: `GET`, `DELETE`, `POST /auth`, `POST /signed-urls` (signing stores
  nothing) and workflow updates. Never for a render, an AI call, a social
  post, a workflow run, a cancel or retry, a key rotation or a webhook
  change: a 502 may hide work that ran and was charged.
- Backoff: 0.5 s, 1 s, 2 s … capped at 8 s, with jitter (50–100 % of the
  delay). `maxRetries` (default 2) counts retries after the first attempt.

## Anything else

`client.request(method, path, { query, body })` sends any v1 call with the
same auth, errors and retries, for endpoints this version doesn't wrap.

## Development

```sh
npm install
npm run typecheck
npm test          # node:test against a scripted local mock server
npm run build     # dist/ (ESM + .d.ts)
```

`test/spec.test.ts` checks the SDK against the API spec in
[`spec/openapi.yaml`](spec/openapi.yaml): every endpoint has a method (or is
skipped on purpose), and the types have exactly the spec's fields and enum
values. `npm run spec:update` downloads the live spec; CI does that every
Monday, so a new API feature shows up as a failing check.

The live smoke test runs against a real API and is skipped unless
`JAMFRAME_SMOKE_API_KEY` is set (`JAMFRAME_SMOKE_BASE_URL` defaults to
`http://localhost:3100`). It spends 2 credits (two one-page PNG renders of a
library template), posts to a sandbox social account only if the workspace
has one, reads AI status, workflows and analytics, and creates and deletes a
webhook subscription:

```sh
JAMFRAME_SMOKE_API_KEY=jf_live_… JAMFRAME_SMOKE_BASE_URL=https://api.jamframe.com npm run test:smoke
```

## Releasing

1. Update `version` in `package.json` and `src/version.ts` (a test checks
   they match) and add the release to [CHANGELOG.md](CHANGELOG.md).
2. Commit, then tag the commit with the bare version (`0.1.1`) and push the
   tag, or create a GitHub release with that tag.
3. [`publish.yml`](.github/workflows/publish.yml) runs the checks and
   publishes to npm with provenance, through npm trusted publishing.

## License

[MIT](LICENSE)

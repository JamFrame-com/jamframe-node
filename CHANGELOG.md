# Changelog

## 0.1.0

The first release.

- Render templates to PNG, JPEG, WebP, PDF and MP4: carousels, Smart Resize
  (one size or several), translation, link lifetimes (`expiresIn`), and the
  experimental PDF options `cmyk` and `compress`.
- Render jobs: `renderAsync`, `renderAndWait`, `renderJobs.get` and `wait`.
- Templates: list, search and get your own and the template library's;
  design new ones with AI (`designs.generate`, `generateAsync`, `designJobs`).
- The render log, signed render URLs.
- Workflows: list, get, create, update, delete, run (and wait), runs, cancel,
  a new incoming webhook URL.
- Social: accounts, posts (create, list, get, cancel, retry) and analytics
  (overview, daily, insights).
- AI tools: remove a background, transcribe speech into subtitles, AI status.
- Webhook subscriptions, and signature checks for deliveries
  (`constructWebhookEvent`, `verifyWebhookSignature`).
- Typed errors, retries for rate limits and safe calls, no runtime dependencies.

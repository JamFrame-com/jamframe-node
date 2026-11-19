import type { Design, DesignDetail, RenderJob, RenderResult, SocialPost } from '../src/index.js';

export const design: Design = {
  id: 'tpl_1',
  name: 'Coffee tips carousel',
  orientation: 'square',
  pages: 3,
  animated: false,
  createdAt: '2026-11-01T09:12:44.000Z',
  updatedAt: '2026-11-05T16:03:10.000Z',
};

export const designDetail: DesignDetail = {
  ...design,
  parameters: [{ key: 'title', type: 'text', pages: [1, 2, 3], example: '5 ways to brew better coffee' }],
  sizes: [{ id: 'story', name: 'Story / Reel', width: 1080, height: 1920 }],
};

export const renderResult: RenderResult = {
  content: 'https://cdn.example.com/r/1.png',
  type: 'url',
  format: 'png',
  pages: [1],
  credits: 1,
  renderId: 'ren_1',
  responseTime: 1840,
};

export function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: 'job_1',
    status: 'queued',
    progress: 0,
    format: 'mp4',
    templateId: 'tpl_1',
    createdAt: '2026-11-09T12:36:24.161Z',
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    ...overrides,
  };
}

export const post: SocialPost = {
  id: 'post_1',
  status: 'queued',
  caption: 'Spring sale',
  createdAt: '2026-11-09T12:00:00.000Z',
  targets: [
    {
      id: 'tgt_1',
      accountId: 'acc_1',
      platform: 'linkedin',
      accountName: 'Acme',
      status: 'queued',
      caption: 'Spring sale',
      warnings: [],
      attempts: 0,
    },
  ],
};

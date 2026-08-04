import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  collectStepScreenshots,
  postRunEvidence,
  selectStepScreenshots,
} from '../../../listeners/actions/run-evidence.js';

/** @param {number} index @param {Record<string, any>} [overrides] */
function step(index, overrides = {}) {
  return { stepId: `s${index}`, stepIndex: index, status: 'ok', reason: null, ...overrides };
}

describe('collectStepScreenshots', () => {
  it('returns nothing when no step produced a screenshot', () => {
    assert.deepStrictEqual(collectStepScreenshots([step(0), step(1)]), []);
  });

  it('orders by the steps own index, not by arrival', () => {
    // The list is the story of what the run did; out-of-order pictures tell it
    // wrong.
    const found = collectStepScreenshots([
      step(3, { evidence: { screenshotUrl: 'https://cdn/3.png' } }),
      step(1, { evidence: { screenshotUrl: 'https://cdn/1.png' } }),
      step(2, { evidence: { screenshotUrl: 'https://cdn/2.png' } }),
    ]);
    assert.deepStrictEqual(
      found.map((entry) => entry.url),
      ['https://cdn/1.png', 'https://cdn/2.png', 'https://cdn/3.png'],
    );
  });

  it('drops a url repeated across steps', () => {
    // A video-backed run can reuse one frame, and the same picture twice reads
    // as two things having happened.
    const found = collectStepScreenshots([
      step(0, { evidence: { screenshotUrl: 'https://cdn/same.png' } }),
      step(1, { evidence: { screenshotUrl: 'https://cdn/same.png' } }),
    ]);
    assert.strictEqual(found.length, 1);
  });

  it('carries the locator label through for a caption', () => {
    const [found] = collectStepScreenshots([
      step(4, { evidence: { screenshotUrl: 'https://cdn/4.png', locatorLabel: 'Submit' } }),
    ]);
    assert.strictEqual(found.label, 'Submit');
    assert.strictEqual(found.stepIndex, 4);
  });

  it('ignores a missing, empty, or non-string url', () => {
    const found = collectStepScreenshots([
      step(0, { evidence: {} }),
      step(1, { evidence: { screenshotUrl: '' } }),
      step(2, { evidence: { screenshotUrl: 42 } }),
      step(3),
    ]);
    assert.deepStrictEqual(found, []);
  });

  it('stops at the limit', () => {
    const steps = Array.from({ length: 20 }, (_, index) =>
      step(index, { evidence: { screenshotUrl: `https://cdn/${index}.png` } }),
    );
    assert.strictEqual(collectStepScreenshots(steps, { limit: 3 }).length, 3);
  });
});

describe('selectStepScreenshots', () => {
  it('prefers the failing steps — they ARE the answer', () => {
    const found = selectStepScreenshots(
      [
        step(0, { evidence: { screenshotUrl: 'https://cdn/ok.png' } }),
        step(1, { status: 'fail', evidence: { screenshotUrl: 'https://cdn/bad.png' } }),
      ],
      5,
    );
    assert.deepStrictEqual(
      found.map((entry) => entry.url),
      ['https://cdn/bad.png'],
    );
  });

  it('still shows a healthy run rather than reporting no evidence', () => {
    const found = selectStepScreenshots(
      [
        step(0, { evidence: { screenshotUrl: 'https://cdn/a.png' } }),
        step(1, { evidence: { screenshotUrl: 'https://cdn/b.png' } }),
      ],
      5,
    );
    assert.strictEqual(found.length, 2);
  });
});

/**
 * The bot MIRRORS `@mcpjam/sdk/platform`'s `selectStepScreenshots` rather than
 * importing it: this service ships only its own runtime dependencies (~38 MB —
 * see the Dockerfile), so pulling the SDK in for one pure function would
 * multiply the image for nothing. That duplication is only safe while the two
 * agree, so this fixture and its expectations are IDENTICAL to the ones in
 * `sdk/tests/platform-step-evidence.test.ts`. A change made to one side and not
 * the other fails on one of them.
 */
describe('parity with the sdk helper', () => {
  const steps = [
    step(2, { evidence: { screenshotUrl: 'https://cdn/2.png' } }),
    step(0, { evidence: { screenshotUrl: 'https://cdn/0.png' } }),
    step(1, { evidence: { screenshotUrl: 'https://cdn/0.png' } }),
    step(3, { status: 'fail', evidence: { screenshotUrl: 'https://cdn/3.png', locatorLabel: 'Submit' } }),
  ];

  it('orders by stepIndex, drops repeats, and prefers failures', () => {
    assert.deepStrictEqual(
      collectStepScreenshots(steps).map((entry) => entry.url),
      ['https://cdn/0.png', 'https://cdn/2.png', 'https://cdn/3.png'],
    );
    assert.deepStrictEqual(selectStepScreenshots(steps, 5), [
      { url: 'https://cdn/3.png', stepId: 's3', stepIndex: 3, status: 'fail', label: 'Submit' },
    ]);
  });
});

describe('postRunEvidence', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
  });

  const ctx = { teamId: 'T1', slackUserId: 'U1', mode: 'user', projectId: 'p1' };

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function png() {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  }

  /**
   * @param {{ iterations?: any, steps?: any, image?: () => Response }} [opts]
   */
  function stubApi(opts = {}) {
    globalThis.fetch = mock.fn(async (url) => {
      const path = String(url);
      if (path.includes('/iterations/') && path.endsWith('/steps')) {
        if (opts.steps instanceof Error) throw opts.steps;
        return json({ items: opts.steps ?? [] });
      }
      if (path.endsWith('/iterations') || path.includes('/iterations?')) {
        if (opts.iterations instanceof Error) throw opts.iterations;
        return json({ items: opts.iterations ?? [] });
      }
      if (path.startsWith('https://cdn/')) return (opts.image ?? png)();
      throw new Error(`unexpected fetch to ${path}`);
    });
  }

  function slackClient() {
    const uploads = [];
    return {
      uploads,
      client: /** @type {any} */ ({
        files: {
          uploadV2: async (payload) => {
            uploads.push(payload);
            return { ok: true };
          },
        },
      }),
    };
  }

  const logger = /** @type {any} */ ({ warn: () => {}, error: () => {}, info: () => {} });

  it('uploads the run screenshots into the thread', async () => {
    stubApi({
      iterations: [{ id: 'it_1' }],
      steps: [
        step(0, { evidence: { screenshotUrl: 'https://cdn/a.png' } }),
        step(1, { status: 'fail', evidence: { screenshotUrl: 'https://cdn/b.png', locatorLabel: 'Submit' } }),
      ],
    });
    const { client, uploads } = slackClient();
    const count = await postRunEvidence(client, {
      runId: 'run_1',
      ctx,
      channelId: 'C1',
      threadTs: '1.0',
      logger,
    });
    assert.strictEqual(count, 1);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].channel_id, 'C1');
    assert.strictEqual(uploads[0].thread_ts, '1.0');
    // The failing step is the one worth showing.
    assert.match(uploads[0].file_uploads[0].title, /Submit/);
    assert.match(uploads[0].file_uploads[0].title, /failed/);
  });

  it('never posts more than five images', async () => {
    stubApi({
      iterations: [{ id: 'it_1' }, { id: 'it_2' }, { id: 'it_3' }],
      steps: Array.from({ length: 30 }, (_, index) =>
        step(index, { evidence: { screenshotUrl: `https://cdn/${index}.png` } }),
      ),
    });
    const { client, uploads } = slackClient();
    const count = await postRunEvidence(client, {
      runId: 'run_1',
      ctx,
      channelId: 'C1',
      threadTs: '1.0',
      logger,
    });
    assert.strictEqual(count, 5);
    assert.strictEqual(uploads[0].file_uploads.length, 5);
  });

  it('posts nothing, and does not throw, when there is no evidence', async () => {
    stubApi({ iterations: [{ id: 'it_1' }], steps: [step(0)] });
    const { client, uploads } = slackClient();
    assert.strictEqual(
      await postRunEvidence(client, { runId: 'run_1', ctx, channelId: 'C1', threadTs: '1.0', logger }),
      0,
    );
    assert.strictEqual(uploads.length, 0);
  });

  it('tolerates an unreadable iteration list', async () => {
    // The run's outcome has already been reported. Evidence must never turn a
    // correct completion message into an unhandled rejection.
    stubApi({ iterations: new Error('backend down') });
    const { client, uploads } = slackClient();
    assert.strictEqual(
      await postRunEvidence(client, { runId: 'run_1', ctx, channelId: 'C1', threadTs: '1.0', logger }),
      0,
    );
    assert.strictEqual(uploads.length, 0);
  });

  it('tolerates an unreadable steps page', async () => {
    stubApi({ iterations: [{ id: 'it_1' }], steps: new Error('boom') });
    const { client } = slackClient();
    assert.strictEqual(
      await postRunEvidence(client, { runId: 'run_1', ctx, channelId: 'C1', threadTs: '1.0', logger }),
      0,
    );
  });

  it('skips an image it cannot download and posts the rest', async () => {
    let call = 0;
    stubApi({
      iterations: [{ id: 'it_1' }],
      steps: [
        step(0, { evidence: { screenshotUrl: 'https://cdn/a.png' } }),
        step(1, { evidence: { screenshotUrl: 'https://cdn/b.png' } }),
      ],
      image: () => {
        call += 1;
        return call === 1 ? new Response('nope', { status: 404 }) : png();
      },
    });
    const { client, uploads } = slackClient();
    const count = await postRunEvidence(client, {
      runId: 'run_1',
      ctx,
      channelId: 'C1',
      threadTs: '1.0',
      logger,
    });
    assert.strictEqual(count, 1);
    assert.strictEqual(uploads[0].file_uploads.length, 1);
  });

  it('refuses an implausibly large image rather than buffering it', async () => {
    stubApi({
      iterations: [{ id: 'it_1' }],
      steps: [step(0, { evidence: { screenshotUrl: 'https://cdn/huge.png' } })],
      image: () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024) },
        }),
    });
    const { client, uploads } = slackClient();
    assert.strictEqual(
      await postRunEvidence(client, { runId: 'run_1', ctx, channelId: 'C1', threadTs: '1.0', logger }),
      0,
    );
    assert.strictEqual(uploads.length, 0);
  });

  it('tolerates a failed upload — the outcome message already stands', async () => {
    stubApi({
      iterations: [{ id: 'it_1' }],
      steps: [step(0, { evidence: { screenshotUrl: 'https://cdn/a.png' } })],
    });
    const client = /** @type {any} */ ({
      files: {
        uploadV2: async () => {
          throw new Error('slack said no');
        },
      },
    });
    assert.strictEqual(
      await postRunEvidence(client, { runId: 'run_1', ctx, channelId: 'C1', threadTs: '1.0', logger }),
      0,
    );
  });
});

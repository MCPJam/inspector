import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { handleProposalButton } from '../../../listeners/actions/proposal-button.js';
import { buildProposalBlocks, PROPOSAL_ACTION_ID } from '../../../listeners/views/proposal-builder.js';

const PROPOSAL = {
  actionId: 'act_1',
  operation: 'run_eval_suite',
  description: 'Run eval suite ts_1',
};

describe('buildProposalBlocks', () => {
  it('renders one confirming button carrying only the action id', () => {
    const blocks = buildProposalBlocks([PROPOSAL]);
    assert.strictEqual(blocks.length, 1);
    const accessory = /** @type {any} */ (blocks[0]).accessory;
    assert.strictEqual(accessory.action_id, PROPOSAL_ACTION_ID);
    assert.strictEqual(accessory.value, 'act_1');
    assert.ok(accessory.confirm, 'spending must be confirmed');
    // The operation and its input are NOT on the wire: the server holds them.
    assert.ok(!JSON.stringify(blocks).includes('suiteId'));
  });

  it('escapes agent-authored descriptions', () => {
    const blocks = buildProposalBlocks([{ ...PROPOSAL, description: 'Run <!channel> now' }]);
    const text = /** @type {any} */ (blocks[0]).text.text;
    assert.ok(!text.includes('<!channel>'), 'a forged mention must not survive');
    assert.ok(text.includes('&lt;!channel&gt;'));
  });

  it('returns nothing for an empty or missing list', () => {
    assert.deepStrictEqual(buildProposalBlocks([]), []);
    assert.deepStrictEqual(buildProposalBlocks(undefined), []);
  });

  it('caps the rendered set and says how many were held back', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ ...PROPOSAL, actionId: `act_${index}` }));
    const blocks = buildProposalBlocks(many);
    assert.strictEqual(blocks.length, 6);
    assert.match(/** @type {any} */ (blocks[5]).elements[0].text, /4 more/);
  });
});

describe('handleProposalButton', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.INSPECTOR_SERVICE_TOKEN = 'svc';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_CONVEX_HTTP_URL;
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
  });

  function stub({ executeStatus = 200, executeBody = { status: 'succeeded', result: {} } } = {}) {
    const state = { executeCalls: [] };
    globalThis.fetch = mock.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/slack/thread-bindings/get')) {
        return json({ binding: { projectId: 'p1', organizationId: 'o1', initiatorSlackUserId: 'U_OTHER' } });
      }
      if (path.includes('/proposed-actions/')) {
        state.executeCalls.push({
          url: path,
          teamHeader: init?.headers?.['x-mcpjam-slack-team-id'],
          userHeader: init?.headers?.['x-mcpjam-slack-user-id'],
        });
        return json(executeBody, executeStatus);
      }
      throw new Error(`unexpected fetch to ${path}`);
    });
    return state;
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function clickArgs(overrides = {}) {
    const posted = [];
    const ephemeral = [];
    return {
      posted,
      ephemeral,
      args: {
        ack: async () => {},
        body: {
          team: { id: 'T1' },
          user: { id: 'U_CLICKER' },
          channel: { id: 'C1' },
          message: { ts: '2.0', thread_ts: '1.0' },
        },
        context: { teamId: 'T1', userId: 'U_CLICKER' },
        client: {
          chat: {
            postMessage: async (payload) => {
              posted.push(payload);
              return { ts: '3.0' };
            },
            postEphemeral: async (payload) => {
              ephemeral.push(payload);
              return {};
            },
          },
        },
        logger: { warn: () => {}, error: () => {}, info: () => {} },
        action: { value: 'act_1' },
        ...overrides,
      },
    };
  }

  it('executes as the CLICKER, not the proposer', async () => {
    const state = stub();
    const { args, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));

    assert.strictEqual(state.executeCalls.length, 1);
    // The thread binding names U_OTHER as the initiator; the headers must still
    // carry the person who clicked.
    assert.strictEqual(state.executeCalls[0].userHeader, 'U_CLICKER');
    assert.strictEqual(state.executeCalls[0].teamHeader, 'T1');
    assert.match(state.executeCalls[0].url, /\/projects\/p1\/proposed-actions\/act_1\/execute$/);
    assert.match(posted[0].text, /<@U_CLICKER>/);
  });

  it('tells the loser of a double-click without implying a failure', async () => {
    stub({ executeStatus: 409, executeBody: { code: 'CONFLICT', message: 'That action is already running.' } });
    const { args, ephemeral, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));

    assert.strictEqual(posted.length, 0);
    assert.match(ephemeral[0].text, /already under way/);
  });

  it('refuses an unlinked clicker instead of spending', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/slack/thread-bindings/get')) return json({ binding: null });
      if (path.endsWith('/slack/links/fetch')) return json({ link: null });
      throw new Error(`must not reach ${path}`);
    });
    const { args, ephemeral } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.match(ephemeral[0].text, /Connect your MCPJam account/);
  });
});

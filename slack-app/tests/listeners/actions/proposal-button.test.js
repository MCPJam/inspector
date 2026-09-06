import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { purgeChannelBindings } from '../../../agent/turn-target.js';
import { announcementFor, handleProposalButton } from '../../../listeners/actions/proposal-button.js';
import {
  buildProposalBlocks,
  PROPOSAL_ACTION_ID,
  rendersRunProposalFor,
} from '../../../listeners/views/proposal-builder.js';

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

  it('prefers the SERVER-sent button label over its own table', () => {
    // What makes a new gated operation reach users properly labelled without a
    // bot deploy.
    const blocks = buildProposalBlocks([{ ...PROPOSAL, operation: 'some_new_op', buttonLabel: 'Do the thing' }]);
    assert.strictEqual(/** @type {any} */ (blocks[0]).accessory.text.text, 'Do the thing');
  });

  it('falls back to its own table, then to a neutral verb, for an older server', () => {
    const known = buildProposalBlocks([{ ...PROPOSAL, buttonLabel: undefined }]);
    assert.strictEqual(/** @type {any} */ (known[0]).accessory.text.text, 'Run it');

    const unknown = buildProposalBlocks([{ ...PROPOSAL, operation: 'some_new_op', buttonLabel: undefined }]);
    // Honest rather than wrong: we do not know what this op does.
    assert.strictEqual(/** @type {any} */ (unknown[0]).accessory.text.text, 'Approve');
  });

  it("keeps the confirm label inside Slack's 30-character allowance", () => {
    // A third of what the button itself allows. Exceeding it fails the block,
    // and a failed block takes the whole message down.
    const blocks = buildProposalBlocks([{ ...PROPOSAL, buttonLabel: 'x'.repeat(70) }]);
    const accessory = /** @type {any} */ (blocks[0]).accessory;
    assert.ok(accessory.text.text.length <= 75);
    assert.ok(accessory.confirm.confirm.text.length <= 30, accessory.confirm.confirm.text.length);
  });

  it('uses sterner copy for an EXTERNAL action, and shows what it will call', () => {
    const blocks = buildProposalBlocks([
      {
        ...PROPOSAL,
        operation: 'call_server_tool',
        confirmSeverity: 'external',
        description: 'Call send_email on mailer',
      },
    ]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.match(text, /third-party/);
    assert.match(text, /cannot undo/);
    assert.match(text, /send_email/);
  });

  it('warns about RECURRING cost for a spend-severity action', () => {
    const blocks = buildProposalBlocks([
      { ...PROPOSAL, operation: 'set_eval_suite_schedule', confirmSeverity: 'spend' },
    ]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.match(text, /RECURRING/);
  });

  it("keeps confirm text inside Slack's 300-character ceiling, warning first", () => {
    const blocks = buildProposalBlocks([
      {
        ...PROPOSAL,
        confirmSeverity: 'external',
        description: 'send_email '.repeat(200),
      },
    ]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.ok(text.length <= 300, `confirm text was ${text.length} chars`);
    // The warning is never what gets truncated.
    assert.match(text, /cannot undo/);
  });

  it('keeps an ESCAPE-EXPANDING description inside the ceiling', () => {
    // Capping before escaping bounds the wrong string: 215 ampersands pass a
    // 215-character cap and arrive as 1,075 characters, which fails the block
    // and takes the whole message down with it.
    const blocks = buildProposalBlocks([{ ...PROPOSAL, confirmSeverity: 'external', description: '&'.repeat(500) }]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.ok(text.length <= 300, `confirm text was ${text.length} chars`);
    // Every ampersand present is a COMPLETE entity — the cut never lands
    // inside `&amp;`.
    assert.strictEqual(text.split('&').length - 1, text.split('&amp;').length - 1);
    assert.match(text, /cannot undo/);
  });

  it('escapes a hostile description inside the confirm dialog too', () => {
    const blocks = buildProposalBlocks([
      { ...PROPOSAL, confirmSeverity: 'external', description: 'Call <!channel> on x' },
    ]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.ok(!text.includes('<!channel>'));
  });

  it('shows a real call preview in the stern dialog, escaped and bounded', () => {
    // What turns "approve a tool call?" into a decision. The preview is server
    // -built from the VALIDATED arguments, so it cannot describe one call while
    // another runs — this side's job is only to render it safely.
    const blocks = buildProposalBlocks([
      {
        ...PROPOSAL,
        operation: 'call_server_tool',
        buttonLabel: 'Call the tool',
        kind: 'external',
        confirmSeverity: 'external',
        description: 'Call send_email(to: <alice@x>, subject: Q3) on mailer',
      },
    ]);
    const accessory = /** @type {any} */ (blocks[0]).accessory;
    assert.strictEqual(accessory.text.text, 'Call the tool');
    const confirm = accessory.confirm.text.text;
    assert.match(confirm, /send_email/);
    assert.match(confirm, /cannot undo/);
    // Raw angle brackets in mrkdwn can forge a link or a mention.
    assert.ok(!confirm.includes('<alice@x>'));
    assert.ok(confirm.includes('&lt;alice@x&gt;'));
    assert.ok(confirm.length <= 300);
  });

  it('does not claim a cost for an action that has none', () => {
    // Disabling a schedule STOPS spending. The default copy asserts the
    // opposite, so `none` has to say so rather than be left absent.
    const blocks = buildProposalBlocks([
      { ...PROPOSAL, operation: 'set_eval_suite_schedule', confirmSeverity: 'none' },
    ]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.match(text, /does not use any quota/);
    assert.ok(!/uses your organization/.test(text));
    // And the SECTION, which is what they read first — a dialog that corrects
    // the message is a dialog most people never open.
    const section = /** @type {any} */ (blocks[0]).text.text;
    assert.match(section, /costs nothing/);
  });

  it('says where an external action goes instead of claiming a quota cost', () => {
    const blocks = buildProposalBlocks([{ ...PROPOSAL, confirmSeverity: 'external' }]);
    const section = /** @type {any} */ (blocks[0]).text.text;
    assert.match(section, /leaves MCPJam/);
  });

  it('keeps the cost warning in the section for everything else', () => {
    const blocks = buildProposalBlocks([{ ...PROPOSAL, confirmSeverity: undefined }]);
    assert.match(/** @type {any} */ (blocks[0]).text.text, /This one costs/);
  });

  it('falls back to the default copy for a severity it does not recognise', () => {
    // A missing warning is worse than a generic one.
    const blocks = buildProposalBlocks([{ ...PROPOSAL, confirmSeverity: /** @type {any} */ ('nuclear') }]);
    const text = /** @type {any} */ (blocks[0]).accessory.confirm.text.text;
    assert.match(text, /runs as \*you\*/);
  });
});

describe('rendersRunProposalFor', () => {
  const suite = { type: 'eval_suite', id: 'ts_1', name: 'Smoke', url: 'https://app/x' };
  const run = { actionId: 'run', operation: 'run_eval_suite', description: 'Run eval suite ts_1' };
  const other = (index) => ({ actionId: `a${index}`, operation: 'cancel_eval_run', description: 'x' });

  it('suppresses on a TARGETLESS run proposal — the older-server fallback', () => {
    // Match-unknown must strip: two buttons for one billed run is the
    // costlier mistake, and this is exactly the pre-target behavior.
    assert.strictEqual(rendersRunProposalFor([run], suite), true);
    assert.strictEqual(rendersRunProposalFor([other(0), run], suite), true);
  });

  it('suppresses only the suite a targeted proposal is actually about', () => {
    // "Make a suite for X and rerun smoke": smoke's proposal renders its own
    // button; X keeps the legacy accessory — stripping it would leave X with
    // NO run affordance at all.
    const targeted = { ...run, target: { type: 'eval_suite', selector: 'ts_other' } };
    assert.strictEqual(rendersRunProposalFor([targeted], suite), false);
    assert.strictEqual(
      rendersRunProposalFor([{ ...run, target: { type: 'eval_suite', selector: 'ts_1' } }], suite),
      true,
    );
  });

  it('matches a name selector case-insensitively — models propose by name', () => {
    const byName = { ...run, target: { type: 'eval_suite', selector: 'smoke' } };
    assert.strictEqual(rendersRunProposalFor([byName], suite), true);
    assert.strictEqual(rendersRunProposalFor([byName], { ...suite, name: 'Checkout' }), false);
  });

  it('is false for a run proposal pushed past the block cap', () => {
    // The suppressed-accessory decision hangs on this. A run proposal at index
    // six is not rendered, and a caller that trusted "the envelope contains
    // one" would leave the suite with NO way to run it.
    const proposals = [...Array.from({ length: 5 }, (_, i) => other(i)), run];
    const rendered = buildProposalBlocks(proposals)
      .filter((block) => block.accessory)
      .map((block) => block.accessory.value);
    assert.ok(!rendered.includes('run'), 'fixture must push the run proposal past the cap');
    assert.strictEqual(rendersRunProposalFor(proposals, suite), false);
  });

  it('is false for a run proposal with no action id — those are skipped too', () => {
    assert.strictEqual(rendersRunProposalFor([{ operation: 'run_eval_suite' }], suite), false);
  });

  it('is false for an empty or missing list', () => {
    assert.strictEqual(rendersRunProposalFor([], suite), false);
    assert.strictEqual(rendersRunProposalFor(undefined, suite), false);
    assert.strictEqual(rendersRunProposalFor([other(0)], suite), false);
  });
});

describe('announcementFor', () => {
  it('words the announcement from the KIND the server sent', () => {
    // "It's away" is true of a run and false of a cancellation.
    assert.match(announcementFor({ operation: 'x', kind: 'start' }, 'U1'), /it's away/);
    assert.match(announcementFor({ operation: 'x', kind: 'cancel' }, 'U1'), /Cancelled by <@U1>/);
    assert.match(announcementFor({ operation: 'x', kind: 'generate' }, 'U1'), /being generated/);
    // Nothing started — saying otherwise would have the user watching for a run
    // that will not appear until the next interval.
    const scheduled = announcementFor({ operation: 'x', kind: 'schedule' }, 'U1');
    assert.match(scheduled, /schedule is updated/);
    assert.ok(!/away/.test(scheduled));
    assert.match(announcementFor({ operation: 'x', kind: 'external' }, 'U1'), /the tool ran/);
  });

  it('prefers the SERVER-built resource link over anything assembled here', () => {
    const text = announcementFor(
      { operation: 'run_eval_suite', kind: 'start', resource: { url: 'https://app/x' } },
      'U1',
    );
    assert.match(text, /<https:\/\/app\/x\|follow it here>/);
    // URL also wins for generate, schedule, and external when the server returns one.
    for (const kind of ['generate', 'schedule', 'external']) {
      const t = announcementFor({ operation: 'x', kind, resource: { url: 'https://app/r' } }, 'U1');
      assert.match(t, /<https:\/\/app\/r\|follow it here>/, `URL should win for kind=${kind}`);
    }
  });

  it('falls back to operation names for a server that predates `kind`', () => {
    assert.match(announcementFor({ operation: 'cancel_eval_run' }, 'U1'), /Cancelled by/);
    assert.match(announcementFor({ operation: 'run_eval_suite' }, 'U1'), /it's away/);
  });

  it('claims nothing for an operation and kind it has never seen', () => {
    const text = announcementFor({ operation: 'some_new_op', kind: 'teleport' }, 'U1');
    assert.strictEqual(text, ':white_check_mark: Approved by <@U1>.');
  });

  it('does not let an UNKNOWN kind fall through to the operation-name table', () => {
    // A kind we do not recognise means a NEWER server, and the name table is
    // older than the kind vocabulary — consulting it would announce a
    // brand-new action as "it's away" on the strength of a familiar name.
    const text = announcementFor({ operation: 'run_eval_suite', kind: 'teleport' }, 'U1');
    assert.strictEqual(text, ':white_check_mark: Approved by <@U1>.');
    assert.ok(!/away/.test(text));
  });
});

describe('handleProposalButton', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Module-global with a 60 s TTL — a leftover entry would decide the next
    // case's turn target.
    purgeChannelBindings('T1');
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_CONVEX_HTTP_URL;
    delete process.env.SLACK_SERVICE_TOKEN;
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

  it('starts a LIVE run message when the approval produced a run', async () => {
    // The same "running… → here's how it went" surface the retired Run-it
    // button gave, now reached through the approval path. Recognised by the
    // server-sent resource TYPE, not by an operation name.
    stub({
      executeBody: {
        status: 'succeeded',
        operation: 'run_eval_suite',
        kind: 'start',
        resource: { type: 'eval_run', id: 'run_1', url: 'https://app/evals/x/runs/run_1' },
        result: {},
      },
    });
    const { args, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text, /running…/);
    assert.match(posted[0].text, /watch it here/);
    assert.match(posted[0].text, /<@U_CLICKER>/);
  });

  it('starts a LIVE swarm message when the approval produced a journey run', async () => {
    // Same recognition rule as eval runs — the server-sent resource TYPE —
    // but a different watcher: journey status vocabulary and verdicts differ,
    // and routing them into the eval watcher misreports rate-limited fan-outs.
    stub({
      executeBody: {
        status: 'succeeded',
        operation: 'launch_journey_run',
        kind: 'start',
        resource: { type: 'journey_run', id: 'jr_1', url: 'https://app/swarms/jr_1?project=p1' },
        result: {},
      },
    });
    const { args, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text, /swarm running…/);
    assert.match(posted[0].text, /watch it here/);
    assert.match(posted[0].text, /<@U_CLICKER>/);
    assert.ok(posted[0].text.includes('https://app/swarms/jr_1'));
  });

  it('posts a plain announcement when the approval produced no run', async () => {
    stub({
      executeBody: { status: 'succeeded', operation: 'cancel_eval_run', kind: 'cancel', result: {} },
    });
    const { args, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.strictEqual(posted.length, 1);
    assert.match(posted[0].text, /Cancelled by <@U_CLICKER>/);
    assert.ok(!/running…/.test(posted[0].text));
  });

  it('tells the clicker plainly when the offer has expired', async () => {
    // Proposals live an hour on purpose, so nobody approves something whose
    // context everyone has forgotten. The server's wording is specific and
    // already user-facing; a generic "something went wrong" would send someone
    // hunting for a fault that does not exist.
    stub({
      executeStatus: 400,
      executeBody: {
        code: 'VALIDATION_ERROR',
        message: "That approval expired. Ask again and I'll propose it fresh.",
      },
    });
    const { args, ephemeral, posted } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.strictEqual(posted.length, 0);
    assert.match(ephemeral[0].text, /expired/);
    assert.match(ephemeral[0].text, /propose it fresh/);
  });

  it('refuses an unlinked clicker instead of spending', async () => {
    globalThis.fetch = mock.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/slack/thread-bindings/get')) return json({ binding: null });
      if (path.endsWith('/slack/channel-bindings/get')) return json({ binding: null });
      if (path.endsWith('/slack/links/fetch')) return json({ link: null });
      throw new Error(`must not reach ${path}`);
    });
    const { args, ephemeral } = clickArgs();
    await handleProposalButton(/** @type {any} */ (args));
    assert.match(ephemeral[0].text, /Connect your MCPJam account/);
  });
});

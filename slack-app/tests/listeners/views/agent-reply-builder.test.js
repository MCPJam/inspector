import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildCreatedResourceBlocks,
  escapeSlackText,
  RUN_SUITE_ACTION_ID,
} from '../../../listeners/views/agent-reply-builder.js';

describe('buildCreatedResourceBlocks', () => {
  it('returns no blocks when nothing was created', () => {
    assert.deepStrictEqual(buildCreatedResourceBlocks([]), []);
  });

  it('builds one Run-it button per created suite', () => {
    const blocks = buildCreatedResourceBlocks([
      { type: 'eval_suite', id: 'ts_1', name: 'smoke', url: 'https://x/evals/suite/ts_1' },
      { type: 'eval_suite', id: 'ts_2', url: 'https://x/evals/suite/ts_2' },
    ]);
    assert.strictEqual(blocks.length, 2);
    for (const block of blocks) {
      assert.strictEqual(block.accessory.action_id, RUN_SUITE_ACTION_ID);
    }
    assert.strictEqual(blocks[0].accessory.value, 'ts_1');
    assert.ok(blocks[0].text.text.includes('smoke'));
  });

  it('RENDERS a resource type it has never heard of instead of dropping it', () => {
    // The server adds created-resource types on its own schedule. A renderer
    // that only understood the types it shipped with would tell the user
    // something was created and show them no link to it — silently, with
    // nothing anywhere reporting a problem.
    const blocks = buildCreatedResourceBlocks([
      { type: 'eval_run', id: 'run_1', url: 'https://x/run' },
      { type: 'chatbox', id: 'cb_1', name: 'Support bot', url: 'https://x/cb' },
    ]);
    assert.strictEqual(blocks.length, 2);
    assert.ok(blocks[0].text.text.includes('https://x/run'));
    assert.ok(blocks[0].text.text.toLowerCase().includes('eval run'));
    assert.ok(blocks[1].text.text.includes('Support bot'));
    // No accessory: we do not know what action would be appropriate, and
    // guessing one is how a button comes to do something nobody intended.
    assert.strictEqual(blocks[0].accessory, undefined);
    assert.strictEqual(blocks[1].accessory, undefined);
  });

  it('escapes markup in an unknown type name AND in its type', () => {
    const [block] = buildCreatedResourceBlocks([
      { type: '<!channel>', id: 'x_1', name: '<@U123> & co', url: 'https://x/u' },
    ]);
    assert.ok(!block.text.text.includes('<!channel>'));
    assert.ok(!block.text.text.includes('<@U123>'));
    assert.ok(block.text.text.includes('<https://x/u|'));
  });

  it('drops only resources with no link to offer', () => {
    // A section whose link is empty renders as broken markup; there is nothing
    // useful to show for a resource we cannot point at.
    const blocks = buildCreatedResourceBlocks([
      { type: 'eval_suite', id: 'ts_1', name: 'smoke', url: '' },
      { type: 'eval_suite', id: 'ts_2', name: 'ok', url: 'https://x/s' },
    ]);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].text.text.includes('ok'));
  });

  it('omits the legacy Run-it accessory when asked to', () => {
    // The proposal path renders its own approval button; both at once would
    // offer the user two ways to start the same billed run.
    const [block] = buildCreatedResourceBlocks(
      [{ type: 'eval_suite', id: 'ts_1', name: 'smoke', url: 'https://x/s' }],
      { suiteAccessory: false },
    );
    assert.strictEqual(block.accessory, undefined);
    assert.ok(block.text.text.includes('smoke'));
  });

  it('KEEPS the accessory by default — the deploy-order case', () => {
    // A bot shipped ahead of the server gets created suites and no proposals.
    // Suppressing unconditionally would let users create suites they have no
    // way to start.
    const suite = [{ type: 'eval_suite', id: 'ts_1', name: 'smoke', url: 'https://x/s' }];
    for (const opts of [{}, { suiteAccessory: true }, { suiteAccessory: undefined }]) {
      const [block] = buildCreatedResourceBlocks(suite, opts);
      assert.strictEqual(block.accessory?.action_id, RUN_SUITE_ACTION_ID, JSON.stringify(opts));
    }
  });

  it('escapes Slack markup in agent-supplied suite names', () => {
    const [block] = buildCreatedResourceBlocks([
      { type: 'eval_suite', id: 'ts_1', name: '<!channel> & "weird" <name>', url: 'https://x/s' },
    ]);
    const text = block.text.text;
    assert.ok(!text.includes('<!channel>'), 'raw mention markup must not survive');
    assert.ok(text.includes('&lt;!channel&gt;'));
    assert.ok(text.includes('&amp;'));
    // The real link markup is still intact.
    assert.ok(text.includes('<https://x/s|'));
  });

  it('stays within Slack block limits when many suites are created', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'eval_suite',
      id: `ts_${i}`,
      name: `suite ${i}`,
      url: `https://x/s${i}`,
    }));
    const blocks = buildCreatedResourceBlocks(many);
    // Room for the feedback block the reply appends, under Slack's 50 cap.
    assert.ok(blocks.length < 50, `got ${blocks.length} blocks`);
    assert.strictEqual(blocks[blocks.length - 1].type, 'context');
    assert.ok(blocks[blocks.length - 1].elements[0].text.includes('more'));
  });
});

describe('escapeSlackText', () => {
  it('escapes &, < and > in that order', () => {
    assert.strictEqual(escapeSlackText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  it('does not double-escape the ampersand it just wrote', () => {
    assert.strictEqual(escapeSlackText('<'), '&lt;');
  });
});

describe('toSuiteLabel', () => {
  it('caps a long name so the section stays under Slack limits', () => {
    const [block] = buildCreatedResourceBlocks([
      { type: 'eval_suite', id: 'ts_1', name: 'x'.repeat(5_000), url: 'https://x/s' },
    ]);
    assert.ok(block.text.text.length < 3_000, `section was ${block.text.text.length} chars`);
    assert.ok(block.text.text.includes('…'));
  });

  it('caps BEFORE escaping so no entity is sliced in half', () => {
    const [block] = buildCreatedResourceBlocks([
      { type: 'eval_suite', id: 'ts_1', name: '&'.repeat(5_000), url: 'https://x/s' },
    ]);
    const text = block.text.text;
    assert.ok(text.length < 3_000);
    // Every ampersand present must be a complete &amp; entity.
    assert.strictEqual(text.split('&').length - 1, text.split('&amp;').length - 1);
  });
});

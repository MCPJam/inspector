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
      { type: 'eval_run', id: 'run_1', url: 'https://x/run' },
    ]);
    assert.strictEqual(blocks.length, 2);
    for (const block of blocks) {
      assert.strictEqual(block.accessory.action_id, RUN_SUITE_ACTION_ID);
    }
    assert.strictEqual(blocks[0].accessory.value, 'ts_1');
    assert.ok(blocks[0].text.text.includes('smoke'));
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

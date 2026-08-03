import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildCreatedResourceBlocks, RUN_SUITE_ACTION_ID } from '../../../listeners/views/agent-reply-builder.js';

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
});

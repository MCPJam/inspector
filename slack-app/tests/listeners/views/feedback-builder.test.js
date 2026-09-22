import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildFeedbackBlocks } from '../../../listeners/views/feedback-builder.js';

describe('buildFeedbackBlocks', () => {
  it('returns a non-empty array', () => {
    const blocks = buildFeedbackBlocks();
    assert.ok(Array.isArray(blocks));
    assert.ok(blocks.length > 0);
  });

  it('first block has type context_actions', () => {
    const blocks = buildFeedbackBlocks();
    assert.strictEqual(blocks[0].type, 'context_actions');
  });

  it('contains feedback action_id', () => {
    const blocks = buildFeedbackBlocks();
    const element = blocks[0].elements[0];
    assert.strictEqual(element.action_id, 'feedback');
  });

  it('has positive and negative buttons', () => {
    const blocks = buildFeedbackBlocks();
    const element = blocks[0].elements[0];
    assert.ok(element.positive_button);
    assert.ok(element.negative_button);
  });
});

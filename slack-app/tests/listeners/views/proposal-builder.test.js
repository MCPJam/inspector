import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildProposalBlocks } from '../../../listeners/views/proposal-builder.js';

/** Slack's own limit on a button label. */
const MAX_BUTTON_LABEL = 75;

const proposalWith = (buttonLabel) => ({
  actionId: 'act_1',
  operation: 'run_eval_suite',
  description: 'Run eval suite ts_1',
  buttonLabel,
});

const labelOf = (blocks) => /** @type {any} */ (blocks[0]).accessory.text.text;

/** A lone half of a surrogate pair, which is what a mid-emoji cut leaves behind. */
const hasLoneSurrogate = (text) => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;
    if (isLow) return true;
    const next = text.charCodeAt(index + 1);
    if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
    index += 1;
  }
  return false;
};

describe('buildProposalBlocks button labels', () => {
  it('leaves a label within the limit alone', () => {
    const blocks = buildProposalBlocks([proposalWith('Run it')]);
    assert.strictEqual(labelOf(blocks), 'Run it');
  });

  it('does not split an emoji sitting on the limit', () => {
    // The rocket is a surrogate PAIR, so it occupies units 74 and 75 of a
    // UTF-16 cut. Slicing there leaves half a character, and Slack can reject
    // the whole message over it: the answer, the links and every other button.
    const label = `${'a'.repeat(74)}🚀${'b'.repeat(20)}`;
    const rendered = labelOf(buildProposalBlocks([proposalWith(label)]));

    assert.ok(!hasLoneSurrogate(rendered), 'a lone surrogate reached the block');
    assert.ok(rendered.length <= MAX_BUTTON_LABEL, 'the label outgrew the limit');
  });

  it('caps a long label by code points rather than UTF-16 units', () => {
    // 80 rockets is 160 UTF-16 units. Counting units would keep 37 of them and
    // call that a 75-character label.
    const rendered = labelOf(buildProposalBlocks([proposalWith('🚀'.repeat(80))]));

    assert.ok(!hasLoneSurrogate(rendered), 'a lone surrogate reached the block');
    assert.ok(Array.from(rendered).length <= MAX_BUTTON_LABEL, 'too many code points');
  });

  it('still falls back to the built-in label when the server sends none', () => {
    const { buttonLabel, ...withoutLabel } = proposalWith('unused');
    assert.strictEqual(labelOf(buildProposalBlocks([withoutLabel])), 'Run it');
  });
});

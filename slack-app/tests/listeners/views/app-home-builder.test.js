import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildAppHomeView } from '../../../listeners/views/app-home-builder.js';

describe('buildAppHomeView', () => {
  it('returns a home view', () => {
    const view = buildAppHomeView();
    assert.strictEqual(view.type, 'home');
  });

  it('has a blocks array with header and section', () => {
    const view = buildAppHomeView();
    assert.ok(Array.isArray(view.blocks));
    assert.ok(view.blocks.length >= 3);
    assert.strictEqual(view.blocks[0].type, 'header');
    assert.strictEqual(view.blocks[1].type, 'section');
  });

  it('describes the eval-suite workflow', () => {
    const view = buildAppHomeView();
    const sectionTexts = view.blocks.filter((b) => b.type === 'section').map((b) => b.text.text);
    assert.ok(sectionTexts.some((t) => t.includes('eval suites')));
  });

  it('caps a project name by code points, never splitting an emoji', () => {
    // The rocket is a surrogate PAIR at units 74 and 75, so a UTF-16 cut at 75
    // leaves half a character in the option text.
    const name = `${'a'.repeat(74)}🚀${'b'.repeat(20)}`;
    const view = buildAppHomeView({ connected: true, projects: [{ id: 'p1', name }] });
    const picker = view.blocks.map((b) => /** @type {any} */ (b).accessory).find((a) => a?.type === 'static_select');
    const text = picker.options[0].text.text;

    assert.strictEqual(text, `${'a'.repeat(74)}🚀`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'a lone high surrogate reached the option');
  });
});

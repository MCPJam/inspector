import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSlack } from '../../render/slack.js';

test('Slack renderer owns mrkdwn mentions, links, and escaping', () => {
  const payload = renderSlack({
    severity: 'success',
    parts: ['Hello <team> ', { mention: 'U1' }, ' — ', { link: { url: 'https://example.test', label: 'details' } }],
  });
  assert.equal(payload.text, ':white_check_mark: Hello &lt;team&gt; <@U1> — <https://example.test|details>');
});

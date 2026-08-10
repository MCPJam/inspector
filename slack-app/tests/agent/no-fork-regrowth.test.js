import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * turn-runner.js, turn-target.js and connect-link.js used to be independent
 * reimplementations of durable-claim handling, precedence resolution and
 * connect-link minting — each one a place a fix landed once and Discord
 * never got. They are thin adapters now, delegating that behavior to
 * `@mcpjam/surface-core`. These guard against the slow, well-intentioned
 * drift back to a hand-rolled copy: someone fixing a Slack-only bug by
 * adding logic locally instead of upstreaming it, one adapter at a time,
 * until the fork has quietly regrown.
 */

const agentDir = fileURLToPath(new URL('../../agent/', import.meta.url));

describe('slack-app/agent stays a thin layer over @mcpjam/surface-core', () => {
  it('turn-runner.js, turn-target.js and connect-link.js each import the core', () => {
    for (const file of ['turn-runner.js', 'turn-target.js', 'connect-link.js']) {
      const content = readFileSync(`${agentDir}${file}`, 'utf8');
      assert.match(
        content,
        /from ['"]@mcpjam\/surface-core['"]/,
        `${file} no longer imports @mcpjam/surface-core — has its own logic crept back in?`,
      );
    }
  });

  it('binding-cache.js does not exist — channel-binding caching lives in @mcpjam/surface-core', () => {
    assert.throws(
      () => readFileSync(`${agentDir}binding-cache.js`, 'utf8'),
      /ENOENT/,
      'slack-app/agent/binding-cache.js has come back; channel-binding caching belongs in surface-core/src/channel-binding-cache.js',
    );
  });

  it('turn-target.js does not hand-roll its own HTTP transport', () => {
    const content = readFileSync(`${agentDir}turn-target.js`, 'utf8');
    // The old fork built its own AbortController-based `post()`. The thin
    // adapter forwards to `backend.post()` (core's createBackendClient),
    // which owns the timeout/abort/error-mapping now.
    assert.doesNotMatch(
      content,
      /new AbortController\(\)/,
      'turn-target.js constructs its own AbortController — the transport should come from backend.post()',
    );
  });
});

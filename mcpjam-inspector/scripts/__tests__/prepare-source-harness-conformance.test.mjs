import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeTreeDigest } from '../build-local-harness-pack.mjs';
import { packAssetStem } from '../local-harness-pack-harnesses.mjs';
import { sourceConformanceEnvironment } from '../prepare-source-harness-conformance.mjs';

for (const harnessId of ['claude-code', 'codex']) {
  test(`${harnessId}: source conformance pins the built pack and rejects drift`, () => {
    const output = mkdtempSync(join(tmpdir(), 'source-conformance-'));
    try {
      const bundle = join(output, 'runtime', harnessId);
      mkdirSync(bundle, { recursive: true });
      mkdirSync(join(output, 'runtime-src'));
      const bridge = join(bundle, 'bridge.mjs');
      writeFileSync(bridge, 'source bridge');
      const args = { output, harnessId, target: 'linux-x64', version: 'conformance' };
      const treeDigest = computeTreeDigest(bundle).digest;
      const manifest = { schema: 'mcpjam.local-harness-pack/1', harnessId,
        platform: args.target, packVersion: args.version, treeDigest };
      const path = join(output, 'runtime-src',
        `${packAssetStem(harnessId, args.target, args.version)}.manifest.json`);
      writeFileSync(path, JSON.stringify(manifest));
      assert.equal(sourceConformanceEnvironment(args),
        `MCPJAM_LOCAL_HARNESS_PACK_SOURCE=${bundle}\n` +
        `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK=conformance:${treeDigest}\n`);
      writeFileSync(bridge, 'replaced bridge');
      assert.throws(() => sourceConformanceEnvironment(args), /differs from its build manifest/);
      writeFileSync(bridge, 'source bridge');
      writeFileSync(path, JSON.stringify({ ...manifest, platform: 'darwin-arm64' }));
      assert.throws(() => sourceConformanceEnvironment(args), /differs from its build manifest/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}

test('rejects values that could inject another environment variable', () => {
  assert.throws(() => sourceConformanceEnvironment({ output: '/tmp',
    harnessId: 'codex', target: 'linux-x64', version: 'conformance\nOTHER=1' }),
  /Expected output directory/);
});

// Pin source conformance to the pack CI just built, using the existing local
// development override. Published-pack conformance keeps its signed pins.
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTreeDigest } from './build-local-harness-pack.mjs';
import { packAssetStem } from './local-harness-pack-harnesses.mjs';

export function sourceConformanceEnvironment({ output, harnessId, target, version }) {
  if (!['claude-code', 'codex'].includes(harnessId) ||
      !/^(darwin|linux)-(arm64|x64)$|^win32-x64$/.test(target ?? '') ||
      !/^[a-zA-Z0-9._-]+$/.test(version ?? '') || !output) {
    throw new Error('Expected output directory, harness, target and pack version');
  }
  const root = resolve(output);
  const bundle = join(root, 'runtime', harnessId);
  if (/[\r\n]/.test(bundle)) throw new Error('Invalid bundle path');
  const manifest = JSON.parse(readFileSync(join(root, 'runtime-src',
    `${packAssetStem(harnessId, target, version)}.manifest.json`), 'utf8'));
  if (manifest.schema !== 'mcpjam.local-harness-pack/1' ||
      manifest.harnessId !== harnessId || manifest.platform !== target ||
      manifest.packVersion !== version ||
      manifest.treeDigest !== computeTreeDigest(bundle).digest) {
    throw new Error('Source conformance pack differs from its build manifest');
  }
  return `MCPJAM_LOCAL_HARNESS_PACK_SOURCE=${bundle}\n` +
    `MCPJAM_LOCAL_HARNESS_EXPECTED_PACK=${version}:${manifest.treeDigest}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, harnessId, target, version] = process.argv.slice(2);
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
  appendFileSync(process.env.GITHUB_ENV,
    sourceConformanceEnvironment({ output, harnessId, target, version }));
}

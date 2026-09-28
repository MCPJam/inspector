/** Hash every pack input; --write updates the reviewed snapshot, default checks. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'mcpjam-inspector/server/utils/harness/local/pack-inputs.generated.json');
export async function computePackInputs() {
  const paths = [
    'package-lock.json',
    'mcpjam-inspector/scripts/build-local-harness-pack.mjs',
    'mcpjam-inspector/scripts/check-local-harness-inputs.mjs',
    'mcpjam-inspector/scripts/local-harness-toolchain.json',
    'mcpjam-inspector/scripts/read-local-harness-toolchain.mjs',
    'mcpjam-inspector/server/utils/harness/claude-code-bootstrap.ts',
    'mcpjam-inspector/server/utils/harness/local/pack/launcher.mjs',
    'mcpjam-inspector/server/utils/harness/local/runtime-identity.ts',
  ];
  const launcher = 'mcpjam-inspector/tools/mcpjam-job-launcher';
  for (const name of await readdir(resolve(root, launcher))) {
    if (/\.go$|^go\.(mod|sum)$/.test(name)) paths.push(`${launcher}/${name}`);
  }
  const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const inputs = {};
  for (const path of paths.sort()) inputs[path] = hash(await readFile(resolve(root, path)));
  const { createClaudeCodeHarness } = await tsImport('../server/utils/harness/claude-code-bootstrap.ts', { parentURL: import.meta.url, tsconfig: false });
  const recipe = await createClaudeCodeHarness().getBootstrap();
  for (const file of [...recipe.files].sort((a,b) => a.path.localeCompare(b.path))) {
    inputs[`recipe/${file.path.slice(recipe.bootstrapDir.length + 1)}`] = hash(file.content);
  }
  return { schema: 1, fingerprint: hash(JSON.stringify(inputs)), inputs };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = `${JSON.stringify(await computePackInputs(), null, 2)}\n`;
  if (process.argv.includes('--write')) await writeFile(output, result);
  else {
    const recorded = await readFile(output, 'utf8').catch(() => '');
    if (recorded !== result) throw new Error('Pack inputs changed. Run node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --write and review the fingerprint; publish a new pack before recording its digests.');
  }
  process.stdout.write(`Pack input fingerprint verified: ${relative(root, output)}\n`);
}

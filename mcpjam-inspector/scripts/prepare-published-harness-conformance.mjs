/** Download and verify the exact pinned release bytes before native conformance. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { computeHarnessPackInputs } from './check-local-harness-inputs.mjs';
import { packAssetStem, packReleaseBaseUrl } from './local-harness-pack-harnesses.mjs';

// Usage: <version> <target> <output dir> [<harness id, default claude-code>]
const [version, target, output, harnessId = 'claude-code'] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^(darwin|linux)-(arm64|x64)$|^win32-x64$/.test(target ?? '') || !output) throw new Error('Expected version, platform target and output directory');
if (!/^[a-z][a-z0-9-]{0,63}$/.test(harnessId)) throw new Error('Expected a harness id');
const load = path => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { PACK_RECORDS } = await load('../server/utils/harness/local/pack-digests.generated.ts');
const { verifyPackManifestSignature } = await load('../server/utils/harness/local/pack-signing-key.ts');
const { computeTreeDigest } = await load('../server/utils/harness/local/runtime-identity.ts');
const record = PACK_RECORDS[harnessId]?.[target];
if (record?.packVersion !== version) throw new Error('Published conformance requires the reviewed pack record for this exact version and target');
const root = resolve(output);
await mkdir(root, { recursive: true });
const stem = packAssetStem(harnessId, target, version);
async function download(suffix) {
  const response = await fetch(`${packReleaseBaseUrl(harnessId, version)}${stem}${suffix}`);
  if (!response.ok) throw new Error(`Pack asset ${suffix}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const bytes = await download('.manifest.json');
const signature = await download('.manifest.json.sig');
const verified = verifyPackManifestSignature(bytes, signature.toString('utf8').trim());
if (!verified.ok) throw new Error(verified.message);
const manifest = JSON.parse(bytes.toString('utf8'));
if (manifest.schema !== 'mcpjam.local-harness-pack/1' || manifest.platform !== target || manifest.harnessId !== harnessId || manifest.packVersion !== version || manifest.treeDigest !== record.treeDigest || manifest.inputsFingerprint !== (await computeHarnessPackInputs(harnessId)).fingerprint) throw new Error('Published pack differs from the reviewed source and runtime identity');
const archive = await download('.tar.gz');
if (createHash('sha256').update(archive).digest('hex') !== manifest.archive.sha256) throw new Error('Published archive checksum mismatch');
const archivePath = join(root, `${stem}.tar.gz`);
await writeFile(archivePath, archive);
const runtime = join(root, 'runtime');
await mkdir(runtime, { recursive: true });
// Extract from INSIDE the target with a relative archive path. Git for Windows'
// GNU tar cannot open a drive-letter directory given to -C ("D:\…\runtime:
// Cannot open"), and reads `D:` in an archive path as a remote host unless
// told --force-local; a relative path gives it neither form to misread.
execFileSync('tar', ['-xzf', `../${stem}.tar.gz`], { cwd: runtime });
if (await computeTreeDigest(join(runtime, harnessId)) !== record.treeDigest) throw new Error('Extracted release tree differs from the reviewed digest');
await writeFile(join(root, 'published-conformance-input.json'), JSON.stringify({ harnessId, version, target, treeDigest: record.treeDigest, archiveSha256: manifest.archive.sha256 }));
process.stdout.write(`Verified published ${harnessId} ${version} for ${target}\n`);

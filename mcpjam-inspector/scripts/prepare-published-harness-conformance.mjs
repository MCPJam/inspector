/**
 * Download and verify the exact pinned release bytes before native conformance.
 *
 * Usage: <version> <target> <output dir> [<harness id, default claude-code>] [--candidate]
 *
 * The pack's identity is its signed manifest and its tree digest, checked here
 * against the pack this checkout pins — as DESIRED or as PERMITTED previous
 * (`runtime-compat.generated.json`). Both roles need evidence: a release runs
 * this build's Inspector layer against every pack it may select.
 *
 * `--candidate` is the publication pipeline's one exception: a pack it has
 * just published and not yet pinned (its pin PR is what this run's evidence
 * lets it open). Nothing pins it yet, so the anchor is instead that its
 * SIGNED manifest names this checkout's own inputs fingerprint — the pack was
 * built from exactly this commit's pack inputs — and that the tree on disk
 * hashes to the digest that manifest signs.
 *
 * Deliberately NOT checked: that the pack was built from this checkout's pack
 * inputs. That is the release gate's question (a pack-input change must be
 * published, or proven equivalent, before release). Conformance asks a
 * different one — does THIS checkout's layer run on the PINNED pack? — and
 * must be answerable on a pull request that changed the bridge, before any
 * new pack exists.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { packAssetStem, packReleaseBaseUrl } from './local-harness-pack-harnesses.mjs';
import { readRuntimeCompat } from './local-harness-pack-tables.mjs';

const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));
const [version, target, output, harnessId = 'claude-code'] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (flags.some(flag => flag !== '--candidate')) throw new Error(`Unknown flag: ${flags.join(' ')}`);
const candidate = flags.includes('--candidate');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^(darwin|linux)-(arm64|x64)$|^win32-x64$/.test(target ?? '') || !output) throw new Error('Expected version, platform target and output directory');
if (!/^[a-z][a-z0-9-]{0,63}$/.test(harnessId)) throw new Error('Expected a harness id');
const load = path => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { verifyPackManifestSignature } = await load('../server/utils/harness/local/pack-signing-key.ts');
const { computeTreeDigest } = await load('../server/utils/harness/local/tree-digest.ts');

const slot = readRuntimeCompat().harnesses[harnessId]?.targets[target];
let pinned = [slot?.desired, slot?.permitted].find(ref => ref?.packVersion === version);
let role = pinned === undefined ? null : pinned === slot.desired ? 'desired' : 'permitted';
if (!pinned && !candidate) throw new Error(`${harnessId} ${version} is neither the desired nor the permitted pack this checkout pins for ${target}`);

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
if (!pinned) {
  const { computeHarnessPackInputs } = await import('./check-local-harness-inputs.mjs');
  const { fingerprint } = await computeHarnessPackInputs(harnessId);
  if (manifest.inputsFingerprint !== fingerprint) throw new Error(`${harnessId} ${version} is not pinned, and its signed manifest was not built from this checkout's pack inputs`);
  pinned = { packVersion: version, treeDigest: manifest.treeDigest };
  role = 'candidate';
}
if (manifest.schema !== 'mcpjam.local-harness-pack/1' || manifest.platform !== target || manifest.harnessId !== harnessId || manifest.packVersion !== version || manifest.treeDigest !== pinned.treeDigest) throw new Error('Published pack differs from the pinned runtime identity');
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
if (await computeTreeDigest(join(runtime, harnessId)) !== pinned.treeDigest) throw new Error('Extracted release tree differs from the pinned digest');
await writeFile(join(root, 'published-conformance-input.json'), JSON.stringify({ harnessId, version, target, role, treeDigest: pinned.treeDigest, archiveSha256: manifest.archive.sha256, inputsFingerprint: manifest.inputsFingerprint ?? null }));
process.stdout.write(`Verified published ${harnessId} ${version} (${role}) for ${target}\n`);

/**
 * Fingerprint every input that produces a runtime pack, PER HARNESS.
 * `--write` updates the reviewed snapshot; the default checks it.
 *
 * ── What "per harness" has to mean ───────────────────────────────────────
 * Each harness's pack has its own version and its own release, so each needs
 * a fingerprint that moves exactly when ITS bytes could move — no more, no
 * less. Splitting one fingerprint into two records would not do that while
 * both still hashed one monolithic build script holding both recipes: an edit
 * to the Codex recipe would still read as a Claude Code input change, and
 * every Codex iteration would demand a Claude Code re-publication.
 *
 * So the inputs are partitioned by what actually consumes them:
 *
 *   - SHARED inputs: the generic orchestration every pack is built by (the
 *     build script, this script, the recipe loader, the workflow, the
 *     toolchain pins, the loopback launcher, the tree-digest module, the Job
 *     Object launcher). A change here invalidates EVERY harness's pack, and
 *     must: those bytes are in, or decide, every pack. Never drop a real
 *     input from this list to keep CI green — publish the affected packs.
 *   - PER-HARNESS inputs: the harness's recipe module, the sources its recipe
 *     declares, the locked dependency closure of its declared roots, and the
 *     recipe bytes it actually emits. Nothing another harness reads.
 *
 * The output is one file with a record per harness, so a reviewer sees both
 * fingerprints side by side and a Codex-only change leaves the Claude Code
 * record byte-identical.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listPackHarnessIds, loadPackHarness, packRecipeModulePath } from './local-harness-pack-harnesses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'mcpjam-inspector/server/utils/harness/local/pack-inputs.generated.json');

/** The machinery every pack is built by. Repo-relative. */
export const SHARED_PACK_INPUTS = [
  '.github/workflows/local-harness-pack.yml',
  'mcpjam-inspector/scripts/build-local-harness-pack.mjs',
  'mcpjam-inspector/scripts/check-local-harness-inputs.mjs',
  'mcpjam-inspector/scripts/local-harness-pack-harnesses.mjs',
  'mcpjam-inspector/scripts/local-harness-toolchain.json',
  'mcpjam-inspector/scripts/read-local-harness-toolchain.mjs',
  'mcpjam-inspector/server/utils/harness/local/pack/launcher.mjs',
  'mcpjam-inspector/server/utils/harness/local/runtime-identity.ts',
];
const JOB_LAUNCHER_DIR = 'mcpjam-inspector/tools/mcpjam-job-launcher';

/** Only dependencies which produce the pack; unrelated Inspector bumps do not republish it. */
export function packDependencyClosure(packages, roots = ['@ai-sdk/harness-claude-code']) {
  const visited = new Map();
  function locate(name, parent = '') {
    let base = parent;
    for (;;) {
      const key = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[key]) return key;
      if (!base) return null;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut >= 0 ? base.slice(0, cut) : '';
    }
  }
  function visit(key) {
    if (visited.has(key)) return;
    const pkg = packages[key];
    visited.set(key, { version: pkg.version, integrity: pkg.integrity, resolved: pkg.resolved });
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
      const child = locate(name, key);
      if (child) visit(child);
      else if (!pkg.optionalDependencies?.[name]) throw new Error(`Missing pack dependency ${name} from ${key}`);
    }
  }
  // Roots resolve the way Node resolves them for the build, which runs in the
  // Inspector workspace: its own `node_modules` first, then the repo root. A
  // workspace-local copy (the Inspector's `@ai-sdk/harness`, its `esbuild`) is
  // the one that produces the pack, not whatever the root hoisted.
  for (const name of roots) {
    const key = locate(name, 'mcpjam-inspector');
    if (!key) throw new Error(`Missing pack dependency ${name}`);
    visit(key);
  }
  return Object.fromEntries([...visited].sort(([a], [b]) => a.localeCompare(b)));
}

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * What is actually installed at a lockfile key (`node_modules/x`,
 * `mcpjam-inspector/node_modules/@scope/y`): `absent`, `linked` (the path, or
 * a directory above it inside the repo, is a symlink — `npm link`, a `file:`
 * dependency), or the installed `package.json` version.
 */
async function inspectInstalledPackage(key) {
  const full = resolve(root, key);
  try {
    await lstat(full);
  } catch {
    return { kind: 'absent' };
  }
  // realpath, not lstat of the leaf: a linked `@ai-sdk` scope directory
  // redirects every package under it while each leaf is a plain directory.
  const [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
  if (real !== join(realRoot, relative(root, full))) return { kind: 'linked', target: real };
  try {
    const pkg = JSON.parse(await readFile(join(full, 'package.json'), 'utf8'));
    return { kind: 'installed', version: String(pkg.version ?? '') };
  } catch {
    return { kind: 'installed', version: '' };
  }
}

/** The real filesystem and repo, for everything but tests. */
export const defaultPackInputIo = {
  readFile: path => readFile(resolve(root, path)),
  readdir: path => readdir(resolve(root, path)),
  readLockPackages: async () => JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')).packages,
  listHarnesses: async () => listPackHarnessIds(),
  loadHarness: harnessId => loadPackHarness(harnessId),
  inspectInstalled: key => inspectInstalledPackage(key),
};

/** Where an `@ai-sdk/harness*` package can be installed in this workspace. */
const HARNESS_SCOPE_DIRS = ['node_modules/@ai-sdk', 'mcpjam-inspector/node_modules/@ai-sdk'];

/**
 * Why the installed tree cannot produce a trustworthy snapshot, or [] when it
 * can.
 *
 * The recipe's EMITTED bytes — the Claude Code bridge, the Codex bundle — are
 * read from whatever `node_modules` holds, not from the lockfile. A snapshot
 * written from a stale install (#5823) or a linked adapter checkout records
 * hashes no clean CI install will ever reproduce, and the pack built from the
 * lock then fails the release check it was supposed to satisfy. These are the
 * two ways that has actually happened, so `--write` refuses both:
 *
 *   - a package in any harness's locked closure is installed at a different
 *     version than `package-lock.json` names (or not installed at all, unless
 *     the lock marks it optional — a platform package for another OS);
 *   - an `@ai-sdk/harness*` package, or anything in a closure, is a symlink.
 */
export async function installedClosureDrift(io = defaultPackInputIo) {
  const packages = await io.readLockPackages();
  const keys = new Set();
  for (const harnessId of await io.listHarnesses()) {
    const recipe = await io.loadHarness(harnessId);
    for (const key of Object.keys(packDependencyClosure(packages, recipe.dependencyRoots))) keys.add(key);
  }
  for (const dir of HARNESS_SCOPE_DIRS) {
    const names = await io.readdir(dir).catch(() => []);
    for (const name of names) if (String(name).startsWith('harness')) keys.add(`${dir}/${name}`);
  }
  const problems = [];
  for (const key of [...keys].sort()) {
    const installed = await io.inspectInstalled(key);
    const locked = packages[key];
    if (installed.kind === 'linked') {
      problems.push(`${key} is a symlink (to ${installed.target ?? 'elsewhere'}); a linked package's bytes are not the locked ones`);
    } else if (installed.kind === 'absent') {
      if (locked !== undefined && locked.optional !== true) problems.push(`${key} is not installed (package-lock.json has ${locked.version})`);
    } else if (locked === undefined) {
      problems.push(`${key} is installed (${installed.version}) but package-lock.json has no entry for it`);
    } else if (installed.version !== locked.version) {
      problems.push(`${key} is installed at ${installed.version || '(unknown)'} but package-lock.json has ${locked.version}`);
    }
  }
  return problems;
}

/** Shared inputs, with the Go sources the Job Object launcher is built from. */
async function sharedInputPaths(io) {
  const paths = [...SHARED_PACK_INPUTS];
  for (const name of await io.readdir(JOB_LAUNCHER_DIR)) {
    if (/\.go$|^go\.(mod|sum)$/.test(name)) paths.push(`${JOB_LAUNCHER_DIR}/${name}`);
  }
  return paths;
}

/**
 * One harness's fingerprint and the inputs behind it.
 *
 * `io` is the seam the isolation tests use: they swap bytes for one file and
 * check which fingerprints move.
 */
export async function computeHarnessPackInputs(harnessId, io = defaultPackInputIo) {
  const recipe = await io.loadHarness(harnessId);
  const inputs = {};
  inputs['pack-dependency-closure'] = hash(JSON.stringify(packDependencyClosure(await io.readLockPackages(), recipe.dependencyRoots)));
  const paths = new Set([
    ...(await sharedInputPaths(io)),
    packRecipeModulePath(harnessId),
    ...recipe.recipeSources,
  ]);
  for (const path of [...paths].sort()) inputs[path] = hash(await io.readFile(path));
  const emitted = await recipe.loadRecipe();
  for (const file of [...emitted.files].sort((a, b) => a.path.localeCompare(b.path))) {
    inputs[`recipe/${file.path.slice(emitted.bootstrapDir.length + 1)}`] = hash(file.content);
  }
  // The harness id is part of what is hashed, so two harnesses can never
  // share a fingerprint by having identical inputs.
  return { fingerprint: hash(JSON.stringify({ harnessId, inputs })), inputs };
}

/** Every harness's record, in the shape the generated file holds. */
export async function computePackInputs(io = defaultPackInputIo) {
  const harnesses = {};
  for (const harnessId of await io.listHarnesses()) {
    harnesses[harnessId] = await computeHarnessPackInputs(harnessId, io);
  }
  return { schema: 2, harnesses };
}

/** The reviewed record for one harness, or null when none is committed. */
export async function readRecordedPackInputs(harnessId) {
  const recorded = JSON.parse(await readFile(output, 'utf8'));
  if (recorded.schema !== 2) throw new Error('pack-inputs.generated.json predates per-harness fingerprints; regenerate it');
  return recorded.harnesses?.[harnessId] ?? null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const write = process.argv.includes('--write');
  if (write) {
    const drift = await installedClosureDrift();
    if (drift.length > 0) {
      process.stderr.write(
        'Refusing to write pack-inputs.generated.json: the installed tree is not the locked one, so the ' +
          'recorded recipe hashes would not match a clean install.\n' +
          drift.map(problem => `  - ${problem}\n`).join('') +
          'Run `npm ci --legacy-peer-deps` from the repo root (and unlink any linked adapter), then retry.\n',
      );
      process.exit(1);
    }
  }
  const result = `${JSON.stringify(await computePackInputs(), null, 2)}\n`;
  if (write) await writeFile(output, result);
  else {
    const recorded = await readFile(output, 'utf8').catch(() => '');
    if (recorded !== result) throw new Error('Pack inputs changed. Run node mcpjam-inspector/scripts/check-local-harness-inputs.mjs --write and review which harness fingerprints moved; publish a new pack for each before recording its digests.');
  }
  process.stdout.write(`Pack input fingerprints verified: ${relative(root, output)}\n`);
}

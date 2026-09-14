#!/usr/bin/env node
/**
 * Build `../sdk` only when its `dist/` is older than its sources.
 *
 * The Electron dev path needs `sdk/dist` to exist: the embedded server imports
 * `@mcpjam/sdk`, the workspace symlink points at `../sdk`, and that package's
 * `main`/`types` resolve into `dist/`. `dist/` is gitignored, so a fresh clone
 * has none and `electron:dev` would fail on an unresolvable import.
 *
 * Unconditionally building it is not an option either: `sdk:build` measured at
 * ~73s on a warm machine, which alone exceeds the whole cold-start budget for
 * `electron:dev` and would be paid on every single launch. So compare mtimes
 * and skip the 73s when nothing changed, which is the common case.
 *
 * The comparison is deliberately pessimistic: stale if the NEWEST input is
 * newer than the OLDEST output. Using the oldest output means a half-finished
 * or partially-overwritten `dist/` also counts as stale, and the failure
 * direction is a redundant rebuild rather than a stale SDK silently linked
 * into a dev session — which presents as a type error or a missing export far
 * from its cause.
 *
 * One wrinkle worth knowing about: `sdk:build` runs `bundle:runtimes` first,
 * which GENERATES `sdk/src/*.bundled.ts` -- the build writes into its own input
 * tree. It still settles correctly, because `tsup` writes `dist/` afterwards and
 * so ends up newer. But anything that builds the SDK concurrently (the repo-root
 * `npm run typecheck` does, via `npm run build -w @mcpjam/sdk`) will make this
 * report stale, which is the right answer rather than a false positive.
 *
 * Escape hatches:
 *   MCPJAM_FORCE_SDK_BUILD=1  always build
 *   MCPJAM_SKIP_SDK_BUILD=1   never build (you are managing `sdk/dist` yourself,
 *                             e.g. running `npm run build -w @mcpjam/sdk --watch`)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this file, never process.cwd(): npm `pre*` hooks run with the
// package dir as cwd today, but this script is also useful from the repo root
// and from a worktree, and a wrong base here silently "finds" no sources and
// reports everything fresh.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const inspectorDir = path.resolve(scriptDir, "..");
const sdkDir = path.resolve(inspectorDir, "..", "sdk");
const distDir = path.join(sdkDir, "dist");

/** Inputs whose change should invalidate `dist/`. Directories are walked. */
const INPUTS = [
  "src",
  "scripts",
  "package.json",
  "tsup.config.ts",
  "tsconfig.json",
];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * Newest and oldest file mtime under `target` (a file or a directory).
 *
 * `SKIP_DIRS` is checked only for descendants, never for the root being walked:
 * `dist` is both an output we must measure and a name we must not recurse into
 * from elsewhere, and skipping it at the root made `oldest` stay `Infinity`, so
 * every comparison reported "up to date" and the SDK was never rebuilt.
 */
function mtimeExtremes(target) {
  let newest = 0;
  let oldest = Infinity;

  const visit = (p, isRoot) => {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return; // vanished mid-walk, or an optional input that does not exist
    }
    if (stat.isDirectory()) {
      if (!isRoot && SKIP_DIRS.has(path.basename(p))) return;
      for (const entry of fs.readdirSync(p)) visit(path.join(p, entry), false);
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (stat.mtimeMs < oldest) oldest = stat.mtimeMs;
  };

  visit(target, true);
  return { newest, oldest };
}

function decide() {
  if (process.env.MCPJAM_SKIP_SDK_BUILD === "1") {
    return { build: false, why: "MCPJAM_SKIP_SDK_BUILD=1" };
  }
  if (process.env.MCPJAM_FORCE_SDK_BUILD === "1") {
    return { build: true, why: "MCPJAM_FORCE_SDK_BUILD=1" };
  }
  if (!fs.existsSync(sdkDir)) {
    // Not a monorepo checkout (published tarball, odd worktree). Nothing we can
    // build, and nothing we should fail: the import either resolves from the
    // registry or the real error surfaces at build time with a better message.
    return { build: false, why: `no SDK checkout at ${sdkDir}` };
  }
  if (!fs.existsSync(distDir) || fs.readdirSync(distDir).length === 0) {
    return { build: true, why: "sdk/dist is missing or empty" };
  }

  const newestInput = Math.max(
    ...INPUTS.map((entry) => mtimeExtremes(path.join(sdkDir, entry)).newest),
  );
  const oldestOutput = mtimeExtremes(distDir).oldest;
  // `Infinity` means the walk found no FILES under `dist/` -- only directories.
  // `readdirSync` above is satisfied by those directories, so without this the
  // comparison below is `newestInput > Infinity`, i.e. always "fresh", and a
  // half-created or half-deleted `dist/` would never be rebuilt. `electron:dev`
  // does not check build outputs the way packaging does, so the first sign
  // would be an unresolvable `@mcpjam/sdk` import.
  if (!Number.isFinite(oldestOutput)) {
    return { build: true, why: "sdk/dist contains no files, only directories" };
  }
  if (newestInput > oldestOutput) {
    return {
      build: true,
      why: `sdk/dist is stale (newest source ${new Date(newestInput).toISOString()} > oldest output ${new Date(oldestOutput).toISOString()})`,
    };
  }
  return { build: false, why: "sdk/dist is up to date" };
}

const { build, why } = decide();

if (!build) {
  console.log(`[sdk] skipping build: ${why}`);
  process.exit(0);
}

console.log(`[sdk] building: ${why}`);
const result = spawnSync("npm", ["--prefix", sdkDir, "run", "build"], {
  stdio: "inherit",
  // Windows resolves `npm` to `npm.cmd`; since Node's CVE-2024-27980 hardening
  // spawning a `.cmd` without a shell throws EINVAL.
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(`[sdk] failed to start the SDK build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

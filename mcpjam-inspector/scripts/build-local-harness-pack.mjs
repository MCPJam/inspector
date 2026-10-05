// Builds a local-harness runtime pack: the verified, per-platform tree that a
// supervised native harness launches from.
//
// ── Why a pack, and why it is not in the npm package ─────────────────────
// A harness's bridge needs its own frozen dependency graph, and the vendor
// CLIs are hundreds of megabytes of Mach-O/ELF/PE that the bridge spawns
// directly. They cannot ship inside `@mcpjam/inspector` (npm would refuse the
// size and every user would pay it), and coupling Electron notarization to a
// third-party binary of that size is its own problem. So each harness's pack
// is built here, signed, published as a release asset, and downloaded on first
// use.
//
// ── Shared orchestration, per-harness recipes ────────────────────────────
// This script is the GENERIC half and is a pack input of every harness. What
// is specific to one harness — staging its bootstrap recipe, installing its
// frozen graph, checksum-verifying its vendor binary, pruning, reporting its
// vendor packages — lives in `local-harness-pack-recipes/<harnessId>.mjs`,
// which is a pack input of that harness only. `--harness` selects one; it
// defaults to `claude-code`, the pack this script built before it was split.
//
// ── What goes in (every harness) ─────────────────────────────────────────
//   - the harness recipe, byte-identical to the one used at runtime;
//   - `launcher.mjs`, Inspector-owned, which forces the bridge's listeners
//     onto loopback and then imports the bridge;
//   - a hoisted, symlink-free `node_modules` with no `.bin` shims;
//   - `bin/node`, an official nodejs.org build, because Electron's `RunAsNode`
//     fuse is off and the npx server's own Node is outside the digest;
//   - on Windows, the Job Object launcher.
//
// ── What comes out ───────────────────────────────────────────────────────
//   <stem>.tar.gz, <stem>.tar.gz.sha256, <stem>.manifest.json (+ .sig),
//   <stem>.sbom.json — where <stem> is `packAssetStem(harness, target, ver)`:
//   `local-harness-pack-<target>-<ver>` for Claude Code (its original names)
//   and `local-harness-pack-<harness>-<target>-<ver>` for every other harness.
//   The archive's single top-level directory is the harness id.
//
// The tarball is built with `--sort=name --mtime --owner=0 --group=0
// --numeric-owner`, so two builds of the same inputs produce the same bytes.
//
// Usage:
//   node scripts/build-local-harness-pack.mjs \
//     --harness claude-code \
//     --node-tarball /tmp/node-v24.20.0-linux-x64.tar.xz \
//     --platform linux-x64 \
//     --out .pack-out \
//     [--pack-version 3] [--sign-key-file key.pem] [--skip-archive]
//     [--job-launcher path/to/mcpjam-job-launcher.exe]   (win32 only)
import { createHash, sign as edSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackHarness, packAssetStem } from "./local-harness-pack-harnesses.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = resolve(scriptDir, "..");
const toolchain = JSON.parse(readFileSync(join(scriptDir, "local-harness-toolchain.json"), "utf8"));

/**
 * Pack targets this script can build.
 *
 * Cross-building is only PARTLY supported, and it is worth being exact about
 * where the line is. The bundled Node is fine — its version is read from the
 * archive name when the binary cannot be run here. A vendor CLI is not: each
 * harness's dependency graph resolves its own platform package, so a pack for
 * a foreign platform has no native binary to checksum unless that package is
 * forced into the install. The workflow therefore builds each target on a
 * matching runner, and a recipe refuses a cross-build with a message that says
 * exactly this rather than with `ENOEXEC` from somewhere further down.
 */
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    i += 1;
  }
  return args;
}

function fail(message) {
  console.error(`build-local-harness-pack: ${message}`);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The canonical tree digest, byte-for-byte identical to `computeTreeDigest` in
 * `server/utils/harness/local/runtime-identity.ts`.
 *
 * Deliberately duplicated rather than imported: this script is plain ESM run by
 * a bare Node in CI, and the server module is TypeScript with its own import
 * graph. `pack-digests.test.ts` is what keeps the two honest — it builds a
 * fixture tree with both and asserts they agree.
 */
export function computeTreeDigest(root) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;

  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`pack contains a symlink at ${rel}`);
      }
      if (entry.isDirectory()) {
        hash.update(`d\0${rel}\0`);
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`pack contains a non-regular file at ${rel}`);
      }
      files += 1;
      const info = statSync(full);
      bytes += info.size;
      const content = readFileSync(full);
      const executable = (info.mode & 0o111) !== 0 ? "1" : "0";
      hash.update(`f\0${rel}\0${executable}\0${info.size}\0`);
      hash.update(createHash("sha256").update(content).digest());
    }
  };

  walk(root);
  return { digest: `sha256:${hash.digest("hex")}`, files, bytes };
}

function rmDirsNamed(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    if (entry.name === name) {
      rmSync(full, { recursive: true, force: true });
      continue;
    }
    rmDirsNamed(full, name);
  }
}

function findSymlinks(root, found = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      found.push(relative(root, full));
      continue;
    }
    if (entry.isDirectory()) findSymlinks(full, found);
  }
  return found;
}

/**
 * Give every file in the tree its own inode.
 *
 * pnpm populates `node_modules` by hardlinking out of its content-addressable
 * store, so a staged pack contains hundreds of paths sharing an inode. The tree
 * digest does not care — a hardlink is a regular file, and it hashes every path
 * it walks — but tar does: GNU tar records the second and later paths as
 * hardlink ENTRIES, and the installer's extractor accepts only regular files
 * and directories. Those files never landed, and the extracted tree hashed to
 * something the manifest had never seen. Every install failed verification.
 *
 * Fixed here rather than by loosening the extractor, which would mean admitting
 * an entry that is a reference to another entry, and rather than only by
 * `--hard-dereference`, which is a GNU-tar flag and this build also runs where
 * `tar` is bsdtar. Making it a property of the TREE means the archive is
 * one-entry-per-file whichever tar writes it.
 *
 * Costs ~113 KB compressed on a real 494 MB pack: almost all of the store's
 * sharing is between packs, not inside one.
 */
export function flattenHardLinks(root, flattened = { count: 0 }) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      flattenHardLinks(full, flattened);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = statSync(full);
    if (info.nlink <= 1) continue;
    // Copy then rename, so the path is never absent and never a partial file:
    // writing through the link would edit every other path sharing the inode.
    const temporary = `${full}.mcpjam-unlink`;
    copyFileSync(full, temporary);
    chmodSync(temporary, info.mode & 0o7777);
    renameSync(temporary, full);
    flattened.count += 1;
  }
  return flattened.count;
}

/** Extract the pack's `bin/node` from an official nodejs.org tarball. */
function installBundledNode(packRoot, nodeTarball, platformKey) {
  const binDir = join(packRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, platformKey.startsWith("win32") ? "node.exe" : "node");
  /** The archive's single top-level directory, e.g. `node-v24.20.0-linux-x64`. */
  let extractedRoot = null;

  if (statSync(nodeTarball).isFile() && /\.(tar\.(gz|xz)|zip)$/.test(nodeTarball)) {
    const staging = mkdtempSync(join(tmpdir(), "mcpjam-node-"));
    try {
      if (nodeTarball.endsWith(".zip")) {
        // `tar` first: Windows 10+ ships bsdtar, which reads zip, and Git Bash
        // on the runner does not reliably have `unzip`. Falling back the other
        // way round would fail on the platform this branch exists for.
        try {
          execFileSync("tar", ["-xf", nodeTarball, "-C", staging], {
            stdio: "inherit",
          });
        } catch {
          execFileSync("unzip", ["-q", nodeTarball, "-d", staging], {
            stdio: "inherit",
          });
        }
      } else {
        execFileSync("tar", ["-xf", nodeTarball, "-C", staging], {
          stdio: "inherit",
        });
      }
      const roots = readdirSync(staging);
      if (roots.length !== 1) {
        fail(`expected one directory inside ${nodeTarball}, found ${roots.length}`);
      }
      extractedRoot = roots[0];
      const extracted = join(
        staging,
        roots[0],
        platformKey.startsWith("win32") ? "node.exe" : join("bin", "node"),
      );
      copyFileSync(extracted, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } else {
    // A bare binary, which is what a local development build usually has.
    copyFileSync(nodeTarball, target);
  }

  chmodSync(target, 0o755);
  return { version: nodeVersion(target, extractedRoot, platformKey), sha256: sha256File(target) };
}

/**
 * The bundled Node's version, asked of the binary when we can run it.
 *
 * A cross-built pack — a darwin-x64 pack from an arm64 Mac, say — contains a
 * binary this host cannot execute, and `execFileSync` threw ENOEXEC before the
 * manifest was ever written. The version nodejs.org already encodes in the
 * archive's directory name is read instead, and that name has to be
 * well-formed rather than merely present.
 *
 * The host case still ASKS THE BINARY, because that is the stronger answer:
 * it proves the file runs, not merely that it was named plausibly.
 */
function nodeVersion(target, extractedRoot, platformKey) {
  const native = platformKey === `${process.platform}-${process.arch}`;
  if (native) {
    return execFileSync(target, ["--version"], { encoding: "utf8" }).trim();
  }
  // The ARCHITECTURE too, not just the version. nodejs.org names its archives
  // `node-<version>-<os>-<arch>`, and matching only the version prefix accepted
  // a linux-x64 tarball while building a pack stamped darwin-arm64 — a pack
  // whose manifest says one target and whose `bin/node` is another. Nothing
  // downstream could catch that: the digest would be computed over the wrong
  // binary and would verify perfectly on the user's machine, right up to the
  // exec that cannot run it.
  //
  // Split into a STATIC regex plus a string comparison, rather than building a
  // pattern out of `platformKey`. That argument comes from `--platform`, and
  // interpolating it into a regex is regex injection — CodeQL flagged it as
  // high severity, correctly: a value containing regex metacharacters would
  // silently change what "matches this target" means, in the one check that
  // stands between a pack's label and its actual contents. Plain `===` on the
  // captured suffix is both safer and a stricter test than any pattern.
  const archiveSuffix = platformKey === "win32-x64" ? "win-x64" : platformKey;
  const named = /^node-(v\d+\.\d+\.\d+)-(.+)$/.exec(extractedRoot ?? "");
  if (named === null || named[2] !== archiveSuffix) {
    fail(
      `cross-building ${platformKey} on ${process.platform}-${process.arch}: ` +
        `the bundled Node cannot be run here, so its archive directory has to ` +
        `name both the version and the target. Expected ` +
        `node-<version>-${archiveSuffix}, got ` +
        `${JSON.stringify(extractedRoot ?? "(a bare binary)")}. Pass the ` +
        `official nodejs.org archive for ${platformKey}, or build on a ` +
        `${platformKey} host.`,
    );
  }
  console.log(
    `[pack] cross-building: bundled Node version ${named[1]} read from the ` +
      `archive name, not from the binary`,
  );
  return named[1];
}

/**
 * Run pnpm, on a platform where "run pnpm" is not one thing.
 *
 * pnpm installs on Windows as `pnpm.CMD`, and since Node's 2024 mitigation for
 * CVE-2024-27980 `execFile` refuses to run a `.cmd` without a shell — so the
 * bare name that works everywhere else reports "pnpm is not on PATH" on the one
 * platform where it plainly is.
 *
 * A shell is acceptable HERE and nowhere near the supervised command path: this
 * is a build script whose arguments are constants and build-chosen paths, not
 * a translator handing a user's tool call to a process. What a shell does bring
 * is word splitting, so an argument containing a space would silently become
 * two — refused outright rather than mis-parsed.
 */
function runPnpm(args, options) {
  if (process.platform !== "win32") {
    return execFileSync("pnpm", args, options);
  }
  const unsafe = args.filter((a) => /\s/.test(String(a)));
  if (unsafe.length > 0) {
    fail(
      `cannot pass an argument containing whitespace to pnpm through the ` +
        `Windows shell: ${JSON.stringify(unsafe)}. Build to a path with no ` +
        `spaces in it.`,
    );
  }
  return execFileSync("pnpm", args, { ...options, shell: true });
}

/**
 * Refuse a pnpm too old for the adapter's recipe, before it fails obscurely.
 *
 * The recipe's `pnpm-workspace.yaml` carries one key, `allowBuilds` — pnpm 10
 * syntax, and what lets the vendor SDK's extract script run and materialize the
 * native CLI. pnpm 9 reads the same file, finds no `packages` field, and exits
 * with "packages field missing or empty", which says nothing about the actual
 * problem. This does.
 */
function assertPnpmVersion() {
  let version;
  try {
    version = runPnpm(["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail("pnpm is not on PATH; the pack build installs the adapter's recipe with it");
  }
  if (version !== toolchain.pnpm) {
    fail(`pnpm ${version} differs from the pack pin ${toolchain.pnpm}; install the pinned version before building`);
  }
}

/**
 * The tar to archive with, and whether it is GNU.
 *
 * This build runs on all five platform runners, and `tar` is bsdtar on the
 * macOS and Windows ones — where `--sort` and `--hard-dereference` do not
 * exist, so a single GNU invocation would fail three of the five legs outright.
 * `gtar` is checked second because that is what a GNU tar is called on a host
 * whose `tar` is not one.
 */
function resolveTar() {
  for (const bin of ["tar", "gtar"]) {
    try {
      const version = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/GNU tar/.test(version)) return { bin, gnu: true };
    } catch {
      // Not installed, or too old to answer `--version`; try the next name.
    }
  }
  return { bin: "tar", gnu: false };
}

/**
 * Arguments that list an archive with this tar.
 *
 * Reading the archive back needs `--force-local` for the same reason writing
 * it does: GNU tar reads the colon in `D:\a\_temp\…` as an rmt `host:path`
 * spec. bsdtar has no such flag, so it is GNU-only here too.
 */
export function archiveListArgs(tar, archivePath) {
  return [...(tar.gnu ? ["--force-local"] : []), "-tzf", archivePath];
}

/**
 * Refuse an archive carrying AppleDouble members.
 *
 * The suppression above is a flag, and a flag is a claim. This reads the
 * archive back and checks it — because the failure it prevents does not show
 * up until a user on macOS downloads the pack and the installer rejects it,
 * which is the worst possible place to discover that a tar on some future
 * runner image ignored `COPYFILE_DISABLE`.
 *
 * Listing an archive works on every tar this build runs under, so this is not
 * conditional on which one produced it.
 */
function assertNoAppleDoubleMembers(tar, archivePath) {
  let listing;
  try {
    listing = execFileSync(tar.bin, archiveListArgs(tar, archivePath), {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    fail(`could not list the archive to check it: ${error.message}`);
  }
  const appleDouble = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => basename(line).startsWith("._"));
  if (appleDouble.length > 0) {
    fail(
      `the archive carries ${appleDouble.length} AppleDouble member(s) — ` +
        `${appleDouble.slice(0, 5).join(", ")}. They are not in the tree ` +
        `digest, so every install of this pack would extract extra files and ` +
        `fail verification. COPYFILE_DISABLE=1 did not take effect on this ` +
        `host's tar.`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformKey = String(args.platform ?? "");
  if (!PLATFORMS.includes(platformKey)) {
    fail(
      `--platform must be one of ${PLATFORMS.join(", ")}, got ` +
        `${platformKey || "(none)"}`,
    );
  }
  const harnessId = String(args.harness ?? "claude-code");
  let recipe;
  try {
    recipe = await loadPackHarness(harnessId);
  } catch (error) {
    fail(error.message);
  }
  const outRoot = resolve(String(args.out ?? join(inspectorRoot, ".pack-out")));
  const nodeTarball = args["node-tarball"]
    ? resolve(String(args["node-tarball"]))
    : null;
  if (nodeTarball === null) fail("--node-tarball is required");

  // The archive's top-level directory is the harness id: the installer
  // extracts it and digests `<version>/<harnessId>`.
  const packRoot = join(outRoot, harnessId);
  rmSync(packRoot, { recursive: true, force: true });
  mkdirSync(packRoot, { recursive: true });

  // 1. The same recipe used by runtime dispatch and conformance, with the
  //    harness's frozen dependency graph installed into it. Hoisted: the
  //    verified tree refuses pnpm's default symlink layout.
  let bridgeDigest;
  try {
    ({ bridgeDigest } = await recipe.stageRecipe(packRoot, () => {
      assertPnpmVersion();
      process.stdout.write(`[pack] installing the ${harnessId} recipe's frozen dependency graph…\n`);
      runPnpm(
        [
          "install",
          "--frozen-lockfile",
          "--node-linker=hoisted",
          "--store-dir",
          join(outRoot, ".pnpm-store"),
        ],
        { cwd: packRoot, stdio: "inherit", env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.includes("SIGNING_KEY"))) },
      );
    }));
  } catch (error) {
    fail(error.stack ?? error.message);
  }
  // Read after staging: a recipe whose identity comes from a build product
  // (Codex's bridge bundle) has produced it by now.
  const adapterVersion = recipe.adapterVersion();
  const packVersion = String(args["pack-version"] ?? adapterVersion);

  // 2. The Inspector-owned loopback launcher, from the repo (digest-covered,
  //    reviewed in a diff like any other source file).
  copyFileSync(
    join(inspectorRoot, "server/utils/harness/local/pack/launcher.mjs"),
    join(packRoot, "launcher.mjs"),
  );

  // 3. Verify the vendor binary, then prune. `.bin` shims are symlinks and
  //    nothing in the pack invokes them; what else a harness drops is its
  //    recipe's call.
  let vendor;
  try {
    vendor = recipe.verifyVendorBinary(packRoot, platformKey);
    recipe.prunePack(packRoot, platformKey);
  } catch (error) {
    fail(error.message);
  }
  rmDirsNamed(join(packRoot, "node_modules"), ".bin");
  for (const stray of [".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
    rmSync(join(packRoot, "node_modules", stray), { force: true });
  }

  // 4. The pack's own Node.
  const node = installBundledNode(packRoot, nodeTarball, platformKey);
  if (node.version !== `v${toolchain.node}`) {
    fail(`Bundled Node ${node.version} differs from the pack pin v${toolchain.node}`);
  }

  // 4b. Windows only: the Job Object launcher. It goes INSIDE the pack so the
  //     tree digest covers it — the supervisor refuses to enforce whole-tree
  //     cleanup with a helper it has not verified, and a helper sitting beside
  //     the pack would be exactly that.
  if (platformKey.startsWith("win32")) {
    const helperSource = args["job-launcher"]
      ? resolve(String(args["job-launcher"]))
      : null;
    if (helperSource === null || !existsSync(helperSource)) {
      // Not a build failure: a Windows pack without the helper is a pack whose
      // platform stays ineligible even when Windows conformance is recorded.
      console.warn(
        "[pack] no --job-launcher given; this Windows pack cannot prove " +
          "whole-tree cleanup and the platform stays refused",
      );
    } else {
      copyFileSync(helperSource, join(packRoot, "bin", "mcpjam-job-launcher.exe"));
      chmodSync(join(packRoot, "bin", "mcpjam-job-launcher.exe"), 0o755);
    }
  }

  // 5. Refuse a pack with any symlink left in it. The digest would throw at
  //    verification time on the user's machine; failing here instead means the
  //    artifact is never published.
  const symlinks = findSymlinks(packRoot);
  if (symlinks.length > 0) {
    fail(`pack still contains ${symlinks.length} symlink(s): ${symlinks.slice(0, 5).join(", ")}`);
  }

  // 6. And no hardlinks either, for the same reason one step later: the
  //    extractor writes regular files, so the archive has to contain them.
  const flattened = flattenHardLinks(packRoot);
  if (flattened > 0) {
    console.log(`[pack] gave ${flattened} hardlinked file(s) their own inode`);
  }

  const { digest, files, bytes } = computeTreeDigest(packRoot);

  const vendorPackages = recipe.vendorPackages(packRoot);

  // This harness's fingerprint, not a global one: a pack records the inputs
  // that produced IT, so another harness's recipe change cannot make an
  // already-published pack look stale.
  const { computeHarnessPackInputs } = await import("./check-local-harness-inputs.mjs");
  const { fingerprint: inputsFingerprint } = await computeHarnessPackInputs(harnessId);
  const manifest = {
    inputsFingerprint,
    schema: "mcpjam.local-harness-pack/1",
    harnessId,
    packVersion,
    adapterVersion,
    platform: platformKey,
    nodeVersion: node.version,
    treeDigest: digest,
    bridgeDigest,
    files,
    bytes,
    vendorPackages,
    vendorBinary: vendor,
    provenance: {
      builtAt: new Date().toISOString(),
      repository: process.env.GITHUB_REPOSITORY ?? null,
      ref: process.env.GITHUB_REF ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
    },
  };

  const stem = packAssetStem(harnessId, platformKey, packVersion);
  mkdirSync(outRoot, { recursive: true });
  const manifestPath = join(outRoot, `${stem}.manifest.json`);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes);

  // The signature covers the MANIFEST, and the manifest carries the tree
  // digest and the archive's own hash — so one signature transitively covers
  // everything the installer verifies.
  const signKeyFile = args["sign-key-file"] ?? process.env.LOCAL_HARNESS_PACK_SIGNING_KEY_FILE;
  const signKeyPem = signKeyFile
    ? readFileSync(String(signKeyFile), "utf8")
    : process.env.LOCAL_HARNESS_PACK_SIGNING_KEY;

  if (args["skip-archive"] !== true) {
    console.log("[pack] archiving…");
    const archivePath = join(outRoot, `${stem}.tar.gz`);
    const tar = resolveTar();
    // Reproducible: sorted entries, fixed mtime, no owner names, no extended
    // attributes. Two builds of the same inputs give the same bytes, which is
    // what makes a published digest checkable by anybody.
    //
    // GNU only. What VERIFICATION rests on is the tree digest, which is taken
    // from the extracted tree and covers path, type, exec bit, size and
    // content — not mtime, not owner, not entry order. So a bsdtar host still
    // produces a pack that installs and verifies; it just produces a pack
    // whose BYTES another host would not reproduce, and says so.
    const reproducible = tar.gnu
      ? [
          "--sort=name",
          "--mtime=UTC 2020-01-01",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          // Belt and braces with `flattenHardLinks`: the tree has no shared
          // inodes left to record, and this says so to the one tar that would.
          "--hard-dereference",
          // GNU tar reads a colon in the archive name as an rmt REMOTE HOST
          // spec — `host:path` — so on Windows, where the out root is
          // `D:\a\_temp\…`, it tried to reach a machine called `D` and died
          // with "Cannot connect to D: resolve failed". Nothing to do with the
          // archive or the tree. GNU-only, which is why it sits in this array;
          // no other leg has a colon in the path to misread.
          "--force-local",
        ]
      : [];
    if (!tar.gnu) {
      console.warn(
        "[pack] no GNU tar on this host: the archive is not byte-reproducible " +
          "(the tree digest and archive hash are unaffected)",
      );
    }
    // macOS AppleDouble members are not a cosmetic problem — they break every
    // darwin install.
    //
    // bsdtar on macOS stores a file's extended attributes and resource fork as
    // a SIBLING `._name` member. The tree digest is taken from `packRoot`
    // BEFORE archiving, so those members exist in the archive and nowhere in
    // the digest; extraction then produces a tree with extra files, its digest
    // does not match the manifest, and the installer refuses the pack it just
    // downloaded. The vendor CLI arrives with `com.apple.quarantine` and
    // `com.apple.provenance` set, so this is the ordinary case rather than an
    // edge one.
    //
    // `COPYFILE_DISABLE=1` is the documented switch for the copyfile(3) layer
    // bsdtar uses. `--no-mac-metadata` says the same thing on a bsdtar new
    // enough to have it and is ignored by GNU tar, which never wrote these in
    // the first place — so both are set and neither depends on the other.
    const macMetadata =
      !tar.gnu && process.platform === "darwin" ? ["--no-mac-metadata"] : [];
    execFileSync(
      tar.bin,
      [
        ...reproducible,
        ...macMetadata,
        "-czf",
        archivePath,
        "-C",
        outRoot,
        harnessId,
      ],
      { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    assertNoAppleDoubleMembers(tar, archivePath);
    const archiveSha = sha256File(archivePath);
    writeFileSync(
      join(outRoot, `${stem}.tar.gz.sha256`),
      `${archiveSha}  ${basename(archivePath)}\n`,
    );
    manifest.archive = { name: basename(archivePath), sha256: archiveSha };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (signKeyPem) {
    const signature = edSign(
      null,
      readFileSync(manifestPath),
      String(signKeyPem),
    );
    writeFileSync(
      join(outRoot, `${stem}.manifest.json.sig`),
      `${signature.toString("base64")}\n`,
    );
    console.log("[pack] manifest signed");
  } else {
    console.warn(
      "[pack] NO SIGNING KEY — the manifest is unsigned, so the installer " +
        "will refuse this pack unless MCPJAM_LOCAL_HARNESS_PACK_SOURCE names " +
        "it explicitly for development",
    );
  }

  // An SBOM and a license listing, from the graph that is actually in the pack.
  try {
    const sbom = execFileSync(
      "npx",
      ["--yes", "@cyclonedx/cyclonedx-npm", "--output-format", "JSON", "--output-file", "-"],
      { cwd: packRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    writeFileSync(join(outRoot, `${stem}.sbom.json`), sbom);
  } catch {
    // A missing SBOM must not fail the build; the license listing below is the
    // fallback that always works because it reads the tree we just built.
    const licenses = {};
    const scan = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgPath = join(dir, entry.name, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg.name) licenses[`${pkg.name}@${pkg.version}`] = pkg.license ?? "UNKNOWN";
        }
        if (entry.name.startsWith("@")) scan(join(dir, entry.name));
      }
    };
    scan(join(packRoot, "node_modules"));
    writeFileSync(
      join(outRoot, `${stem}.licenses.json`),
      `${JSON.stringify(licenses, null, 2)}\n`,
    );
    console.warn("[pack] cyclonedx unavailable; wrote a license listing instead");
  }

  console.log(
    `[pack] ${stem}: ${files} files, ${(bytes / 1024 / 1024).toFixed(0)} MB, ` +
      `digest ${digest}`,
  );
  // The one line CI reads to update `pack-digests.generated.ts`.
  console.log(`::pack-digest::${platformKey} ${packVersion} ${digest}`);
}

// Only build when run as the entry point, so a test can import the digest
// implementation and prove it agrees with the server's.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.stack ?? error.message));
}

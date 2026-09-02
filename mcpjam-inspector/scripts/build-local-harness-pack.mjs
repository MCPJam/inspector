// Builds the local-harness runtime pack: the verified, per-platform tree that
// the supervised native harness launches Claude Code from.
//
// ── Why a pack, and why it is not in the npm package ─────────────────────
// The adapter's bridge needs its own frozen dependency graph, and Claude Code
// is a 376 MB Mach-O/ELF that the vendor's SDK spawns directly. That is ~515 MB
// on disk. It cannot ship inside `@mcpjam/inspector` (npm would refuse the
// size and every user would pay it), and coupling Electron notarization to a
// third-party binary of that size is its own problem. So it is built here,
// signed, published as a release asset, and downloaded on first use.
//
// ── What goes in ─────────────────────────────────────────────────────────
//   - the adapter's recipe files VERBATIM (`package.json`, `pnpm-lock.yaml`,
//     `pnpm-workspace.yaml`, and `bridge.mjs` byte-identical to the adapter's
//     `dist/bridge/index.mjs`) — the provider byte-compares the bridge, so a
//     single changed byte fails the session closed, which is the point;
//   - `launcher.mjs`, Inspector-owned, which forces the bridge's listener onto
//     loopback and then imports the verbatim bridge;
//   - a hoisted, symlink-free `node_modules`, pruned of the unused
//     `@anthropic-ai/claude-code` wrapper and every `.bin` shim;
//   - `bin/node`, an official nodejs.org build, because Electron's `RunAsNode`
//     fuse is off and the npx server's own Node is outside the digest.
//
// ── What comes out ───────────────────────────────────────────────────────
//   local-harness-pack-<platform>-<packVersion>.tar.gz
//   local-harness-pack-<platform>-<packVersion>.tar.gz.sha256
//   local-harness-pack-<platform>-<packVersion>.manifest.json   (+ .sig)
//   local-harness-pack-<platform>-<packVersion>.sbom.json
//
// The tarball is built with `--sort=name --mtime --owner=0 --group=0
// --numeric-owner`, so two builds of the same inputs produce the same bytes.
//
// Usage:
//   node scripts/build-local-harness-pack.mjs \
//     --adapter-bridge node_modules/@ai-sdk/harness-claude-code/dist/bridge \
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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const inspectorRoot = resolve(scriptDir, "..");

/**
 * Platforms a pack can be built for, and the vendor platform package whose
 * native binary must be present and checksum-verified for each.
 *
 * Kept as an explicit table rather than derived from `process.platform`,
 * because the vendor package name is the only reliable way to find the binary
 * that will actually run.
 *
 * Cross-building is only PARTLY supported, and it is worth being exact about
 * where the line is. The bundled Node is fine — its version is read from the
 * archive name when the binary cannot be run here. The vendor CLI is not: the
 * SDK resolves its own platform package, so a pack for a foreign platform has
 * no `claude` to checksum unless that package is forced into the install. The
 * workflow therefore builds each target on a matching runner, and a
 * cross-build attempt fails with a message that says exactly this rather than
 * with `ENOEXEC` from somewhere further down.
 */
const PLATFORMS = {
  "darwin-arm64": { os: "darwin", vendorSuffix: "darwin-arm64" },
  "darwin-x64": { os: "darwin", vendorSuffix: "darwin-x64" },
  "linux-x64": { os: "linux", vendorSuffix: "linux-x64" },
  "linux-arm64": { os: "linux", vendorSuffix: "linux-arm64" },
  "win32-x64": { os: "win32", vendorSuffix: "win32-x64" },
};

/** Recipe files copied verbatim from the adapter's bridge directory. */
const RECIPE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** The pinned adapter's bridge recipe directory, wherever it installed. */
function defaultAdapterBridgeDir() {
  const required = createRequire(import.meta.url);
  return join(
    dirname(required.resolve("@ai-sdk/harness-claude-code/package.json")),
    "dist",
    "bridge",
  );
}

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

/**
 * Verify the vendor's native CLI against the checksum the SDK publishes for it.
 *
 * This is the one file in the pack that neither we nor npm's integrity check
 * meaningfully vouch for: it is extracted by a postinstall from a platform
 * package. The SDK ships a `manifest.json` listing per-platform checksums, so
 * that is what it is checked against — and a pack whose vendor binary does not
 * match is not built at all, rather than built and rejected later by a user.
 */
function verifyVendorBinary(packRoot, platformKey) {
  const { vendorSuffix } = PLATFORMS[platformKey];
  const sdkDir = join(packRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const manifestPath = join(sdkDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(
      `the adapter's installed SDK has no manifest.json at ${manifestPath}, ` +
        `so the vendor binary cannot be checksum-verified`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const platformPackage = join(
    packRoot,
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${vendorSuffix}`,
  );
  const binaryName = platformKey.startsWith("win32") ? "claude.exe" : "claude";
  const binaryPath = join(platformPackage, binaryName);
  if (!existsSync(binaryPath)) {
    fail(
      `no vendor CLI at ${binaryPath}. The SDK resolves its own platform ` +
        `package, so a pack for ${platformKey} must be built where that ` +
        `package installs (or with the platform package forced in).`,
    );
  }

  // The manifest's shape has moved between SDK versions; accept the two known
  // layouts and refuse rather than guess if it is neither.
  const entry =
    manifest?.platforms?.[vendorSuffix] ??
    manifest?.[vendorSuffix] ??
    manifest?.binaries?.[vendorSuffix];
  const expected =
    typeof entry === "string" ? entry : (entry?.checksum ?? entry?.sha256);
  if (typeof expected !== "string" || expected.length === 0) {
    fail(
      `the SDK manifest lists no checksum for ${vendorSuffix}; refusing to ` +
        `ship a vendor binary nothing vouches for`,
    );
  }
  const actual = sha256File(binaryPath);
  const normalized = expected.replace(/^sha256[:-]/, "");
  if (actual !== normalized) {
    fail(
      `vendor CLI checksum mismatch for ${vendorSuffix}: SDK manifest says ` +
        `${normalized}, file hashes to ${actual}`,
    );
  }
  return {
    path: relative(packRoot, binaryPath).split(sep).join("/"),
    sha256: actual,
    bytes: statSync(binaryPath).size,
  };
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
  const archiveSuffix = platformKey === "win32-x64" ? "win-x64" : platformKey;
  const named = new RegExp(`^node-(v\\d+\\.\\d+\\.\\d+)-${archiveSuffix}$`).exec(
    extractedRoot ?? "",
  );
  if (named === null) {
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
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 10) {
    fail(
      `pnpm ${version} is too old: the adapter's recipe uses \`allowBuilds\` in ` +
        `pnpm-workspace.yaml, which needs pnpm 10 or newer (pnpm 9 reports ` +
        `"packages field missing or empty" instead)`,
    );
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformKey = String(args.platform ?? "");
  if (!(platformKey in PLATFORMS)) {
    fail(
      `--platform must be one of ${Object.keys(PLATFORMS).join(", ")}, got ` +
        `${platformKey || "(none)"}`,
    );
  }
  // Resolved through the package manager, not from the source layout: this is
  // an npm workspace, so the adapter hoists to the REPO root rather than
  // installing under `mcpjam-inspector/node_modules`. A path relative to this
  // script is right on exactly one of those layouts and silently wrong on the
  // other — which is what `check:bundled-runtime-paths` exists to stop.
  const adapterBridge = resolve(
    String(args["adapter-bridge"] ?? defaultAdapterBridgeDir()),
  );
  const outRoot = resolve(String(args.out ?? join(inspectorRoot, ".pack-out")));
  const nodeTarball = args["node-tarball"]
    ? resolve(String(args["node-tarball"]))
    : null;
  if (nodeTarball === null) fail("--node-tarball is required");
  if (!existsSync(adapterBridge)) {
    fail(`no adapter bridge directory at ${adapterBridge}`);
  }

  const required = createRequire(import.meta.url);
  const adapterVersion = JSON.parse(
    readFileSync(
      required.resolve("@ai-sdk/harness-claude-code/package.json"),
      "utf8",
    ),
  ).version;
  const packVersion = String(args["pack-version"] ?? adapterVersion);

  const packRoot = join(outRoot, "claude-code");
  rmSync(packRoot, { recursive: true, force: true });
  mkdirSync(packRoot, { recursive: true });

  // 1. Recipe files, verbatim. The bridge especially: the provider compares
  //    its bytes against the adapter's own copy at session start.
  for (const file of RECIPE_FILES) {
    const source = join(adapterBridge, file);
    if (!existsSync(source)) fail(`adapter recipe is missing ${file}`);
    copyFileSync(source, join(packRoot, file));
  }
  copyFileSync(join(adapterBridge, "index.mjs"), join(packRoot, "bridge.mjs"));
  const bridgeDigest = `sha256:${sha256File(join(packRoot, "bridge.mjs"))}`;

  // 2. The Inspector-owned loopback launcher, from the repo (digest-covered,
  //    reviewed in a diff like any other source file).
  copyFileSync(
    join(inspectorRoot, "server/utils/harness/local/pack/launcher.mjs"),
    join(packRoot, "launcher.mjs"),
  );

  // 3. The adapter's own frozen dependency graph. Hoisted, because the digest
  //    refuses symlinks and pnpm's default store layout is symlinks all the way
  //    down. `--ignore-scripts` everywhere except the vendor SDK's own extract
  //    step, which is what materializes the native CLI.
  assertPnpmVersion();
  console.log("[pack] installing the adapter's frozen dependency graph…");
  runPnpm(
    [
      "install",
      "--frozen-lockfile",
      "--node-linker=hoisted",
      "--store-dir",
      join(outRoot, ".pnpm-store"),
    ],
    { cwd: packRoot, stdio: "inherit" },
  );

  // 4. Prune. The `@anthropic-ai/claude-code` wrapper exists only for the
  //    adapter's `--version` probe, which the translator answers as a no-op;
  //    the SDK resolves its OWN platform package. `.bin` shims are symlinks
  //    and nothing in the pack invokes them.
  const vendor = verifyVendorBinary(packRoot, platformKey);
  for (const entry of readdirSync(join(packRoot, "node_modules/@anthropic-ai"))) {
    if (entry === "claude-code" || entry.startsWith("claude-code-")) {
      rmSync(join(packRoot, "node_modules/@anthropic-ai", entry), {
        recursive: true,
        force: true,
      });
    }
  }
  rmDirsNamed(join(packRoot, "node_modules"), ".bin");
  for (const stray of [".modules.yaml", ".pnpm-workspace-state-v1.json"]) {
    rmSync(join(packRoot, "node_modules", stray), { force: true });
  }

  // 5. The pack's own Node.
  const node = installBundledNode(packRoot, nodeTarball, platformKey);

  // 5b. Windows only: the Job Object launcher. It goes INSIDE the pack so the
  //     tree digest covers it — the supervisor refuses to enforce whole-tree
  //     cleanup with a helper it has not verified, and a helper sitting beside
  //     the pack would be exactly that.
  if (platformKey.startsWith("win32")) {
    const helperSource = args["job-launcher"]
      ? resolve(String(args["job-launcher"]))
      : null;
    if (helperSource === null || !existsSync(helperSource)) {
      // Not a build failure: a Windows pack without the helper is a pack whose
      // platform stays ineligible, which is the state Windows is in today and
      // the state `nativePlatforms` already describes.
      console.warn(
        "[pack] no --job-launcher given; this Windows pack cannot prove " +
          "whole-tree cleanup and the platform stays refused",
      );
    } else {
      copyFileSync(helperSource, join(packRoot, "bin", "mcpjam-job-launcher.exe"));
      chmodSync(join(packRoot, "bin", "mcpjam-job-launcher.exe"), 0o755);
    }
  }

  // 6. Refuse a pack with any symlink left in it. The digest would throw at
  //    verification time on the user's machine; failing here instead means the
  //    artifact is never published.
  const symlinks = findSymlinks(packRoot);
  if (symlinks.length > 0) {
    fail(`pack still contains ${symlinks.length} symlink(s): ${symlinks.slice(0, 5).join(", ")}`);
  }

  // 7. And no hardlinks either, for the same reason one step later: the
  //    extractor writes regular files, so the archive has to contain them.
  const flattened = flattenHardLinks(packRoot);
  if (flattened > 0) {
    console.log(`[pack] gave ${flattened} hardlinked file(s) their own inode`);
  }

  const { digest, files, bytes } = computeTreeDigest(packRoot);

  const vendorPackages = {};
  const anthropicDir = join(packRoot, "node_modules/@anthropic-ai");
  if (existsSync(anthropicDir)) {
    for (const entry of readdirSync(anthropicDir)) {
      const pkg = join(anthropicDir, entry, "package.json");
      if (!existsSync(pkg)) continue;
      vendorPackages[`@anthropic-ai/${entry}`] = JSON.parse(
        readFileSync(pkg, "utf8"),
      ).version;
    }
  }

  const manifest = {
    schema: "mcpjam.local-harness-pack/1",
    harnessId: "claude-code",
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

  const stem = `local-harness-pack-${platformKey}-${packVersion}`;
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
        ]
      : [];
    if (!tar.gnu) {
      console.warn(
        "[pack] no GNU tar on this host: the archive is not byte-reproducible " +
          "(the tree digest and archive hash are unaffected)",
      );
    }
    execFileSync(
      tar.bin,
      [...reproducible, "-czf", archivePath, "-C", outRoot, "claude-code"],
      { stdio: "inherit" },
    );
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
  main();
}

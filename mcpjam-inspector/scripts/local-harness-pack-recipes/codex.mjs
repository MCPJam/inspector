// The Codex runtime pack recipe: everything about building a pack that is
// specific to Codex. The generic orchestration — bundled Node, the Windows Job
// Object launcher, link flattening, the tree digest, archiving, signing — is
// `build-local-harness-pack.mjs`, shared by every harness. This file is a pack
// input of the Codex pack ONLY, so editing it never changes Claude Code's
// fingerprint.
//
// What goes in a Codex pack — VENDOR BYTES ONLY:
//   - a hoisted, symlink-free `node_modules` with the `@openai/codex` wrapper
//     (`bin/codex.js` is what the bridge runs) and EXACTLY one platform
//     package, every file of which is checked against the checksums recorded
//     from the published tarballs (`codex-vendor-checksums.json`);
//   - `bin/node` and, on Windows, the Job Object launcher (the shared build).
//
// What does NOT: MCPJam's app-server bridge, its host-tools MCP entrypoint,
// the loopback launcher and `ws`. They are the Inspector layer
// (`server/utils/harness/local/inspector-layer.ts`), compiled into the
// Inspector and written next to the pack at run time. So a change under
// `server/utils/harness/codex-appserver/` is an ordinary Inspector change: it
// needs no new pack. Only the vendor graph — the bootstrap `package.json` and
// lockfile that pin `@openai/codex`, and the recorded checksums — is an input
// of this pack.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const harnessId = "codex";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const ADAPTER_DIR = "mcpjam-inspector/server/utils/harness/codex-appserver";
const BOOTSTRAP_DIR = `${ADAPTER_DIR}/bootstrap`;

/**
 * Repo-relative sources whose bytes shape this pack: the manifest and lockfile
 * the vendor graph is installed from, and the checksums every vendor file is
 * checked against. Nothing about the bridge.
 */
export const recipeSources = [
  `${BOOTSTRAP_DIR}/package.json`,
  `${BOOTSTRAP_DIR}/pnpm-lock.yaml`,
  "mcpjam-inspector/scripts/local-harness-pack-recipes/codex-vendor-checksums.json",
];

/**
 * Packages whose locked closure (from the repo's package-lock) produces this
 * pack. None: the vendor graph comes from the bootstrap lockfile above, which
 * pnpm installs frozen, and no Inspector dependency reaches the pack any more
 * (the bridge kit and the bundler now produce the Inspector layer).
 */
export const dependencyRoots = [];

/** npm platform package suffix per pack target (`@openai/codex-<suffix>`). */
const VENDOR_SUFFIX = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "win32-x64",
};

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return out.sort();
}

function vendorChecksums() {
  return JSON.parse(readFileSync(join(here, "codex-vendor-checksums.json"), "utf8"));
}

/**
 * The files the pack build installs the vendor graph from: the bootstrap
 * manifest and frozen lockfile, read straight from the repository. Nothing is
 * generated, so neither TypeScript nor esbuild is involved in building a pack.
 */
export async function loadRecipe() {
  const bootstrapDir = ".harness-bootstrap/codex-appserver";
  const files = ["package.json", "pnpm-lock.yaml"].map((name) => ({
    path: `${bootstrapDir}/${name}`,
    content: readFileSync(join(repoRoot, BOOTSTRAP_DIR, name), "utf8"),
  }));
  return { bootstrapDir, files };
}

/** What `stageRecipe` leaves behind besides `node_modules`: nothing. */
const INSTALL_ONLY_FILES = ["package.json", "pnpm-lock.yaml", ".npmrc", "pnpm-workspace.yaml"];

/**
 * Install the frozen vendor graph, then remove everything the pack must not
 * carry: the install manifests (vendor-graph inputs, not runtime) and `ws`,
 * which the hosted bootstrap installs for the sandbox's bridge and which the
 * Inspector layer's bridge has compiled in.
 */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files } = await loadRecipe();
  mkdirSync(packRoot, { recursive: true });
  for (const file of files) {
    writeFileSync(join(packRoot, file.path.slice(bootstrapDir.length + 1)), file.content);
  }
  await installDependencies();
  for (const name of INSTALL_ONLY_FILES) rmSync(join(packRoot, name), { force: true });
  rmSync(join(packRoot, "node_modules", "ws"), { recursive: true, force: true });
  return {};
}

/**
 * Verify the vendor's platform package against the checksums recorded from
 * the published `@openai/codex@<version>-<platform>` tarballs — EVERY file,
 * not just the main binary: the package carries `rg`, `bwrap` (Linux), a
 * bundled `zsh` and the Windows sandbox helpers, and each of them runs. A
 * missing file, an extra one, a different hash, size or exec bit fails the
 * build, rather than shipping something nobody vouched for.
 *
 * Also checks the wrapper is the pinned version: `bin/codex.js` is what the
 * bridge executes, and it resolves the platform package by name.
 */
export function verifyVendorBinary(packRoot, platformKey) {
  const suffix = VENDOR_SUFFIX[platformKey];
  if (suffix === undefined) {
    throw new Error(`no Codex vendor package is known for ${platformKey}`);
  }
  const expected = vendorChecksums()[platformKey];
  if (!expected?.files) {
    throw new Error(
      `codex-vendor-checksums.json records nothing for ${platformKey}; ` +
        `refusing to ship a vendor package nothing vouches for`,
    );
  }
  const wrapperDir = join(packRoot, "node_modules", "@openai", "codex");
  const wrapper = JSON.parse(readFileSync(join(wrapperDir, "package.json"), "utf8"));
  const pinnedVersion = expected.spec.replace(/^@openai\/codex@/, "").replace(`-${suffix}`, "");
  if (wrapper.version !== pinnedVersion) {
    throw new Error(
      `@openai/codex ${wrapper.version} is installed but the checksums were ` +
        `recorded for ${pinnedVersion}`,
    );
  }
  if (!existsSync(join(wrapperDir, "bin", "codex.js"))) {
    throw new Error("the @openai/codex wrapper has no bin/codex.js for the bridge to run");
  }

  const platformDir = join(packRoot, "node_modules", "@openai", `codex-${suffix}`);
  if (!existsSync(platformDir)) {
    throw new Error(
      `no @openai/codex-${suffix} in the pack. pnpm installs the platform ` +
        `package matching the build host, so a pack for ${platformKey} must ` +
        `be built on ${platformKey}.`,
    );
  }
  const actualFiles = walkFiles(platformDir);
  const expectedFiles = Object.keys(expected.files).sort();
  const missing = expectedFiles.filter((path) => !actualFiles.includes(path));
  const extra = actualFiles.filter((path) => !expectedFiles.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `@openai/codex-${suffix} does not match its recorded file list ` +
        `(missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  for (const path of expectedFiles) {
    const record = expected.files[path];
    const absolute = join(platformDir, path);
    const actualSha = sha256File(absolute);
    const want = String(record.sha256).replace(/^sha256[:-]/, "");
    if (actualSha !== want) {
      throw new Error(`checksum mismatch for @openai/codex-${suffix}/${path}: recorded ${want}, file hashes to ${actualSha}`);
    }
    const size = statSync(absolute).size;
    if (size !== record.bytes) {
      throw new Error(`size mismatch for @openai/codex-${suffix}/${path}: recorded ${record.bytes}, file is ${size}`);
    }
    // The exec bit only means something where the build host keeps it.
    if (process.platform !== "win32" && typeof record.mode === "string") {
      const executable = (statSync(absolute).mode & 0o111) !== 0;
      const recordedExecutable = (Number.parseInt(record.mode, 8) & 0o111) !== 0;
      if (executable !== recordedExecutable) {
        throw new Error(`mode mismatch for @openai/codex-${suffix}/${path}: recorded ${record.mode}`);
      }
    }
  }

  const binary = expectedFiles.find((path) =>
    /^vendor\/[^/]+\/bin\/codex(\.exe)?$/.test(path),
  );
  if (binary === undefined) {
    throw new Error(`the recorded file list for ${platformKey} names no codex binary`);
  }
  const binaryPath = join(platformDir, binary);
  return {
    path: relative(packRoot, binaryPath).split(sep).join("/"),
    sha256: sha256File(binaryPath),
    bytes: statSync(binaryPath).size,
  };
}

/**
 * Remove what the pack must not carry, then scan what is left: after pruning,
 * `node_modules` holds the `@openai` scope and nothing else, and that scope
 * holds the wrapper and THIS target's platform package. Anything else is code
 * no checksum covers.
 */
export function prunePack(packRoot, platformKey) {
  const modules = join(packRoot, "node_modules");
  const scope = join(modules, "@openai");
  const suffix = platformKey === undefined ? undefined : VENDOR_SUFFIX[platformKey];
  const allowed = new Set(["codex", ...(suffix ? [`codex-${suffix}`] : [])]);
  for (const entry of readdirSync(scope)) {
    if (entry.startsWith("codex-") && !allowed.has(entry)) {
      rmSync(join(scope, entry), { recursive: true, force: true });
    }
  }
  const remaining = readdirSync(scope).filter((entry) => !allowed.has(entry));
  if (remaining.length > 0) {
    throw new Error(
      `unexpected packages in the pack's @openai scope: ${remaining.join(", ")}`,
    );
  }
  const strays = readdirSync(modules).filter(
    (entry) => entry !== "@openai" && !entry.startsWith("."),
  );
  if (strays.length > 0) {
    throw new Error(
      `unexpected packages in the Codex pack's node_modules: ${strays.join(", ")} ` +
        `(a Codex pack carries @openai/codex and its platform package only)`,
    );
  }
}

/** Exact vendor package versions actually in the pack, for its manifest. */
export function vendorPackages(packRoot) {
  const packages = {};
  const scope = join(packRoot, "node_modules", "@openai");
  if (existsSync(scope)) {
    for (const entry of readdirSync(scope)) {
      const pkg = join(scope, entry, "package.json");
      if (!existsSync(pkg)) continue;
      packages[`@openai/${entry}`] = JSON.parse(readFileSync(pkg, "utf8")).version;
    }
  }
  return packages;
}

/**
 * The identity recorded in the pack manifest: the pinned CLI. The app-server
 * bridge is not in the pack, so its bundle hash is not part of what a pack is;
 * the Inspector's own manifest pins the bridge (`CODEX_LOCAL_ADAPTER_IDENTITY`).
 */
export function adapterVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, BOOTSTRAP_DIR, "package.json"), "utf8"));
  const cli = pkg.dependencies?.["@openai/codex"];
  if (typeof cli !== "string") {
    throw new Error("the Codex bootstrap package pins no @openai/codex version");
  }
  return `@openai/codex@${cli}`;
}

// The GitHub Copilot CLI runtime pack recipe: everything about building a pack
// that is specific to Copilot. The generic orchestration — bundled Node, the
// Windows Job Object launcher, link flattening, the tree digest, archiving,
// signing — is `build-local-harness-pack.mjs`, shared by every harness. This
// file is a pack input of the Copilot pack ONLY.
//
// What goes in a Copilot pack — VENDOR BYTES ONLY:
//   - a hoisted, symlink-free `node_modules` with `@github/copilot` (its
//     `npm-loader.js` and `detect-libc`) and EXACTLY one platform build, every
//     file of which is checked against the checksums recorded from the
//     published tarballs (`copilot-cli-vendor-checksums.json`);
//   - `@github/copilot-sdk` and its JavaScript dependencies, which the bridge
//     imports in-process to drive the CLI;
//   - `bin/node` and, on Windows, the Job Object launcher (the shared build).
//
// What does NOT: MCPJam's bridge, the loopback launcher and `ws`. They are the
// Inspector layer, compiled into the Inspector. Nor `koffi`: only the SDK's
// in-process FFI host loads it, and the bridge runs the CLI over stdio.
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

export const harnessId = "copilot-cli";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const BOOTSTRAP_DIR = "mcpjam-inspector/server/utils/harness/copilot-cli/bridge";
const INSTALL_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/**
 * Repo-relative sources whose bytes shape this pack: the manifest, lockfile
 * and workspace file the vendor graph is installed from, and the checksums
 * every platform file is checked against. Nothing about the bridge.
 */
export const recipeSources = [
  ...INSTALL_FILES.map((name) => `${BOOTSTRAP_DIR}/${name}`),
  "mcpjam-inspector/scripts/local-harness-pack-recipes/copilot-cli-vendor-checksums.json",
];

/** None: the vendor graph comes from the frozen lockfile above. */
export const dependencyRoots = [];

/** Pack target to the platform build `npm-loader.js` runs (`@github/copilot-<suffix>`). */
const VENDOR_SUFFIX = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "win32-x64",
};

/** What a pack's `node_modules` may hold once pruned, besides the platform build. */
const ALLOWED_PACKAGES = ["@github", "detect-libc", "vscode-jsonrpc", "zod"];
/** What staging and pruning remove: the layer's `ws`, and the FFI host's natives. */
const DROPPED_PACKAGES = ["ws", "koffi", "@koromix"];

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
  return JSON.parse(readFileSync(join(here, "copilot-cli-vendor-checksums.json"), "utf8"));
}

function bootstrapManifest() {
  return JSON.parse(readFileSync(join(repoRoot, BOOTSTRAP_DIR, "package.json"), "utf8"));
}

/** The files the pack build installs the vendor graph from, read straight
 *  from the repository. Nothing is generated. */
export async function loadRecipe() {
  const bootstrapDir = ".harness-bootstrap/copilot-cli";
  const files = INSTALL_FILES.map((name) => ({
    path: `${bootstrapDir}/${name}`,
    content: readFileSync(join(repoRoot, BOOTSTRAP_DIR, name), "utf8"),
  }));
  return { bootstrapDir, files };
}

/** Install the frozen vendor graph, then remove the install manifests and
 *  the packages the pack must not carry. */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files } = await loadRecipe();
  mkdirSync(packRoot, { recursive: true });
  for (const file of files) {
    writeFileSync(join(packRoot, file.path.slice(bootstrapDir.length + 1)), file.content);
  }
  await installDependencies();
  for (const name of [...INSTALL_FILES, ".npmrc"]) rmSync(join(packRoot, name), { force: true });
  for (const name of DROPPED_PACKAGES) {
    rmSync(join(packRoot, "node_modules", name), { recursive: true, force: true });
  }
  return {};
}

/**
 * Check the CLI and SDK are the pinned versions, then every file of the
 * target's platform build against the checksums recorded from its published
 * tarball: a missing file, an extra one, a different hash, size or exec bit
 * fails the build rather than shipping something nobody vouched for.
 */
export function verifyVendorBinary(packRoot, platformKey) {
  const suffix = VENDOR_SUFFIX[platformKey];
  if (suffix === undefined) {
    throw new Error(`no GitHub Copilot CLI build is known for ${platformKey}`);
  }
  const expected = vendorChecksums()[platformKey];
  if (!expected?.files) {
    throw new Error(
      `copilot-cli-vendor-checksums.json records nothing for ${platformKey}; ` +
        `refusing to ship a vendor package nothing vouches for`,
    );
  }
  const pins = bootstrapManifest().dependencies ?? {};
  for (const name of ["@github/copilot", "@github/copilot-sdk"]) {
    const installed = JSON.parse(
      readFileSync(join(packRoot, "node_modules", ...name.split("/"), "package.json"), "utf8"),
    ).version;
    if (installed !== pins[name]) {
      throw new Error(`${name} ${installed} is installed but the recipe pins ${pins[name]}`);
    }
  }
  if (`@github/copilot-${suffix}@${pins["@github/copilot"]}` !== expected.spec) {
    throw new Error(`the checksums were recorded for ${expected.spec}, not this recipe's CLI`);
  }
  if (!existsSync(join(packRoot, "node_modules", "@github", "copilot", "npm-loader.js"))) {
    throw new Error("@github/copilot has no npm-loader.js for the bridge to resolve the CLI from");
  }

  const platformDir = join(packRoot, "node_modules", "@github", `copilot-${suffix}`);
  if (!existsSync(platformDir)) {
    throw new Error(
      `no @github/copilot-${suffix} in the pack. pnpm installs the platform ` +
        `build matching the build host, so a pack for ${platformKey} must be ` +
        `built on ${platformKey}.`,
    );
  }
  const actualFiles = walkFiles(platformDir);
  const expectedFiles = Object.keys(expected.files).sort();
  const missing = expectedFiles.filter((path) => !actualFiles.includes(path));
  const extra = actualFiles.filter((path) => !expectedFiles.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `@github/copilot-${suffix} does not match its recorded file list ` +
        `(missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  for (const path of expectedFiles) {
    const record = expected.files[path];
    const absolute = join(platformDir, path);
    const actualSha = sha256File(absolute);
    const want = String(record.sha256).replace(/^sha256[:-]/, "");
    if (actualSha !== want) {
      throw new Error(`checksum mismatch for @github/copilot-${suffix}/${path}: recorded ${want}, file hashes to ${actualSha}`);
    }
    const size = statSync(absolute).size;
    if (size !== record.bytes) {
      throw new Error(`size mismatch for @github/copilot-${suffix}/${path}: recorded ${record.bytes}, file is ${size}`);
    }
    // The exec bit only means something where the build host keeps it.
    if (process.platform !== "win32" && typeof record.mode === "string") {
      const executable = (statSync(absolute).mode & 0o111) !== 0;
      const recordedExecutable = (Number.parseInt(record.mode, 8) & 0o111) !== 0;
      if (executable !== recordedExecutable) {
        throw new Error(`mode mismatch for @github/copilot-${suffix}/${path}: recorded ${record.mode}`);
      }
    }
  }

  const binary = expectedFiles.find((path) => /^copilot(\.exe)?$/.test(path));
  if (binary === undefined) {
    throw new Error(`the recorded file list for ${platformKey} names no copilot binary`);
  }
  const binaryPath = join(platformDir, binary);
  return {
    path: relative(packRoot, binaryPath).split(sep).join("/"),
    sha256: sha256File(binaryPath),
    bytes: statSync(binaryPath).size,
  };
}

/**
 * Drop other platforms' builds and the packages the pack must not carry, then
 * scan what is left: the `@github` scope holds the CLI, the SDK and THIS
 * target's build, and nothing sits beside it but the SDK's and the loader's
 * JavaScript dependencies. Anything else is code no pin covers.
 */
export function prunePack(packRoot, platformKey) {
  const modules = join(packRoot, "node_modules");
  for (const name of DROPPED_PACKAGES) rmSync(join(modules, name), { recursive: true, force: true });
  const scope = join(modules, "@github");
  const suffix = platformKey === undefined ? undefined : VENDOR_SUFFIX[platformKey];
  const allowed = new Set(["copilot", "copilot-sdk", ...(suffix ? [`copilot-${suffix}`] : [])]);
  for (const entry of readdirSync(scope)) {
    if (entry.startsWith("copilot-") && !allowed.has(entry)) {
      rmSync(join(scope, entry), { recursive: true, force: true });
    }
  }
  const remaining = readdirSync(scope).filter((entry) => !allowed.has(entry));
  if (remaining.length > 0) {
    throw new Error(`unexpected packages in the pack's @github scope: ${remaining.join(", ")}`);
  }
  const strays = readdirSync(modules).filter(
    (entry) => !ALLOWED_PACKAGES.includes(entry) && !entry.startsWith("."),
  );
  if (strays.length > 0) {
    throw new Error(
      `unexpected packages in the Copilot pack's node_modules: ${strays.join(", ")} ` +
        `(a Copilot pack carries the CLI, its SDK and their JavaScript dependencies only)`,
    );
  }
}

/** Exact vendor package versions actually in the pack, for its manifest. */
export function vendorPackages(packRoot) {
  const packages = {};
  const scope = join(packRoot, "node_modules", "@github");
  if (existsSync(scope)) {
    for (const entry of readdirSync(scope)) {
      const pkg = join(scope, entry, "package.json");
      if (!existsSync(pkg)) continue;
      packages[`@github/${entry}`] = JSON.parse(readFileSync(pkg, "utf8")).version;
    }
  }
  return packages;
}

/** The identity recorded in the pack manifest: the pinned CLI and SDK. The
 *  bridge is the Inspector layer's, pinned by the layer digest. */
export function adapterVersion() {
  const pins = bootstrapManifest().dependencies ?? {};
  for (const name of ["@github/copilot", "@github/copilot-sdk"]) {
    if (typeof pins[name] !== "string") {
      throw new Error(`the Copilot bridge package pins no ${name} version`);
    }
  }
  return `@github/copilot@${pins["@github/copilot"]}+@github/copilot-sdk@${pins["@github/copilot-sdk"]}`;
}

// The Claude Code runtime pack recipe: everything about building a pack that
// is specific to Claude Code. The generic orchestration — bundled Node, the
// Windows Job Object launcher, link flattening, the tree digest, archiving,
// signing — is `build-local-harness-pack.mjs`, and it is shared by every
// harness. This file is a pack input of Claude Code's pack ONLY, so editing
// another harness's recipe never changes Claude Code's fingerprint.
//
// What goes in a Claude Code pack — VENDOR BYTES ONLY:
//   - `@anthropic-ai/claude-agent-sdk` and its platform package's native CLI,
//     which share a version and are checked against the SDK's own manifest;
//   - the SDK's declared peers (`@anthropic-ai/sdk`, the MCP SDK, `zod`), at
//     the versions the adapter's own lockfile resolves them to;
//   - `bin/node` and, on Windows, the Job Object launcher (the shared build).
//
// What does NOT: the adapter's bridge (patched by `claude-code-bootstrap.ts`),
// with the MCP SDK, `zod` and `ws` it uses compiled in, and the loopback
// launcher. They are the Inspector layer (`server/utils/harness/local/
// inspector-layer.ts`), shipped with the Inspector; the launcher resolves the
// bridge's one external import, the agent SDK, to this pack.
//
// So an adapter bump ships as an Inspector change, and makes a new pack only
// when it moves the agent SDK version: the vendor graph is installed from the
// committed `claude-code-vendor/` manifest and lockfile, and the layer bundler
// refuses to build a bridge whose adapter expects a different SDK than that
// manifest pins (see `vendorSdkVersion`).
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

export const harnessId = "claude-code";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR_NAME = "claude-code-vendor";
const VENDOR_DIR = join(here, VENDOR_DIR_NAME);

/**
 * Repo-relative sources whose bytes shape this pack: the vendor graph's
 * manifest and frozen lockfile. Nothing about the bridge, the adapter or the
 * Inspector's own dependencies.
 */
export const recipeSources = [
  `mcpjam-inspector/scripts/local-harness-pack-recipes/${VENDOR_DIR_NAME}/package.json`,
  `mcpjam-inspector/scripts/local-harness-pack-recipes/${VENDOR_DIR_NAME}/pnpm-lock.yaml`,
];

/**
 * Packages whose locked closure (from the repo's package-lock) produces this
 * pack. None: the adapter no longer reaches the pack, and the vendor graph is
 * pinned by its own lockfile above.
 */
export const dependencyRoots = [];

/** Vendor platform package suffix per pack target. */
const VENDOR_SUFFIX = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "win32-x64",
};

/** The packages a Claude Code pack's `@anthropic-ai` scope may hold. */
const ALLOWED_SCOPE = new Set(["claude-agent-sdk", "sdk"]);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The agent SDK version the vendor manifest pins. */
export function vendorSdkVersion() {
  const pkg = JSON.parse(readFileSync(join(VENDOR_DIR, "package.json"), "utf8"));
  const version = pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("claude-code-vendor/package.json pins no exact @anthropic-ai/claude-agent-sdk version");
  }
  return version;
}

/** The files the pack build installs the vendor graph from. */
export async function loadRecipe() {
  return {
    bootstrapDir: VENDOR_DIR_NAME,
    files: ["package.json", "pnpm-lock.yaml"].map((name) => ({
      path: `${VENDOR_DIR_NAME}/${name}`,
      content: readFileSync(join(VENDOR_DIR, name), "utf8"),
    })),
  };
}

/**
 * Install the frozen vendor graph, then remove the install manifests: they
 * describe the graph, they are not part of what runs.
 */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files } = await loadRecipe();
  mkdirSync(packRoot, { recursive: true });
  for (const file of files) {
    writeFileSync(join(packRoot, file.path.slice(bootstrapDir.length + 1)), file.content);
  }
  await installDependencies();
  for (const name of ["package.json", "pnpm-lock.yaml", ".npmrc", "pnpm-workspace.yaml"]) {
    rmSync(join(packRoot, name), { force: true });
  }
  return {};
}

/**
 * Verify the vendor's native CLI against the checksum the SDK publishes for it.
 *
 * This is the one file in the pack that neither we nor npm's integrity check
 * meaningfully vouch for: it is extracted by a postinstall from a platform
 * package. The SDK ships a `manifest.json` listing per-platform checksums, so
 * that is what it is checked against — and a pack whose vendor binary does not
 * match is not built at all, rather than built and rejected later by a user.
 *
 * Throws with an actionable message; the build turns it into its exit.
 */
export function verifyVendorBinary(packRoot, platformKey) {
  const vendorSuffix = VENDOR_SUFFIX[platformKey];
  if (vendorSuffix === undefined) {
    throw new Error(`no Claude Code vendor package is known for ${platformKey}`);
  }
  const sdkDir = join(packRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const sdkVersion = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
  if (sdkVersion !== vendorSdkVersion()) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk ${sdkVersion} is installed but the vendor ` +
        `manifest pins ${vendorSdkVersion()}`,
    );
  }
  const manifestPath = join(sdkDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `the installed SDK has no manifest.json at ${manifestPath}, ` +
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
    throw new Error(
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
    throw new Error(
      `the SDK manifest lists no checksum for ${vendorSuffix}; refusing to ` +
        `ship a vendor binary nothing vouches for`,
    );
  }
  const actual = sha256File(binaryPath);
  const normalized = expected.replace(/^sha256[:-]/, "");
  if (actual !== normalized) {
    throw new Error(
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

/**
 * Remove what the pack must not carry — other platforms' SDK packages, and
 * the `@anthropic-ai/claude-code` wrapper if a future graph pulls it in (the
 * SDK spawns its OWN platform package's CLI) — then refuse anything else in
 * the `@anthropic-ai` scope.
 */
export function prunePack(packRoot, platformKey) {
  const scope = join(packRoot, "node_modules", "@anthropic-ai");
  const suffix = platformKey === undefined ? undefined : VENDOR_SUFFIX[platformKey];
  for (const entry of readdirSync(scope)) {
    if (entry === "claude-code" || entry.startsWith("claude-code-")) {
      rmSync(join(scope, entry), { recursive: true, force: true });
    } else if (entry.startsWith("claude-agent-sdk-") && entry !== `claude-agent-sdk-${suffix}`) {
      rmSync(join(scope, entry), { recursive: true, force: true });
    }
  }
  const unexpected = readdirSync(scope).filter(
    (entry) => !ALLOWED_SCOPE.has(entry) && entry !== `claude-agent-sdk-${suffix}`,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected packages in the pack's @anthropic-ai scope: ${unexpected.join(", ")}`,
    );
  }
}

/** Exact vendor package versions actually in the pack, for its manifest. */
export function vendorPackages(packRoot) {
  const packages = {};
  const scope = join(packRoot, "node_modules/@anthropic-ai");
  if (!existsSync(scope)) return packages;
  for (const entry of readdirSync(scope)) {
    const pkg = join(scope, entry, "package.json");
    if (!existsSync(pkg)) continue;
    packages[`@anthropic-ai/${entry}`] = JSON.parse(readFileSync(pkg, "utf8")).version;
  }
  return packages;
}

/**
 * The identity recorded in the pack manifest: the agent SDK it carries. The
 * adapter is not in the pack, so its version is not part of what a pack is.
 */
export function adapterVersion() {
  return `@anthropic-ai/claude-agent-sdk@${vendorSdkVersion()}`;
}

// The Claude Code runtime pack recipe: everything about building a pack that
// is specific to Claude Code. The generic orchestration — bundled Node, the
// Windows Job Object launcher, link flattening, the tree digest, archiving,
// signing — is `build-local-harness-pack.mjs`, and it is shared by every
// harness. This file is a pack input of Claude Code's pack ONLY, so editing
// another harness's recipe never changes Claude Code's fingerprint.
//
// What goes in a Claude Code pack:
//   - the Inspector-patched adapter recipe (`package.json`, `pnpm-lock.yaml`,
//     `pnpm-workspace.yaml`, `.npmrc`, and `bridge.mjs`) — byte-identical to
//     the recipe used at runtime. The provider byte-compares the bridge, so a
//     single changed byte fails the session closed, which is the point;
//   - a hoisted, symlink-free `node_modules`, pruned of the unused
//     `@anthropic-ai/claude-code` wrapper (the SDK spawns its own platform
//     package's native CLI).
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
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

export const harnessId = "claude-code";

/**
 * Claude Code's bridge still ships INSIDE its pack, so the pack build copies
 * the loopback launcher in beside it (see `build-local-harness-pack.mjs`).
 */
export const packLauncher = true;

/**
 * Repo-relative sources whose bytes shape this recipe. The recipe's EMITTED
 * bytes are fingerprinted too; these are listed so a change to the code that
 * produces them is visible in the input diff rather than only in its output.
 */
export const recipeSources = [
  "mcpjam-inspector/server/utils/harness/claude-code-bootstrap.ts",
  // Copied into this pack (`packLauncher`), so an input of THIS pack only.
  "mcpjam-inspector/server/utils/harness/local/pack/launcher.mjs",
];

/**
 * Packages whose locked closure (from the repo's package-lock) produces this
 * pack. Only these: an unrelated Inspector dependency bump must not
 * republish the pack.
 */
export const dependencyRoots = ["@ai-sdk/harness-claude-code"];

/** Vendor platform package suffix per pack target. */
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

/**
 * The patched bootstrap recipe exactly as the application writes it.
 *
 * Loaded through tsx only when asked for, so importing this module (for the
 * fingerprint's dependency roots, say) stays independent of TypeScript.
 */
export async function loadRecipe() {
  const { tsImport } = await import("tsx/esm/api");
  const { createClaudeCodeHarness } = await tsImport(
    "../../server/utils/harness/claude-code-bootstrap.ts",
    { parentURL: import.meta.url, tsconfig: false },
  );
  const bootstrap = await createClaudeCodeHarness().getBootstrap();
  return { bootstrapDir: bootstrap.bootstrapDir, files: bootstrap.files, bootstrap };
}

/**
 * Stage exactly the recipe the application writes, installing dependencies
 * before adding its runtime-only .npmrc. The pack install must not inherit
 * dangerously-allow-all-builds from that file in the signing job.
 */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files: recipeFiles, bootstrap } = await loadRecipe();
  const prefix = `${bootstrapDir}/`;
  const files = recipeFiles.map((file) => {
    const name = file.path.slice(prefix.length);
    if (
      !file.path.startsWith(prefix) ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new Error(`Unexpected Claude Code bootstrap path: ${file.path}`);
    }
    return { name, content: file.content };
  });
  const npmrc = files.find((file) => file.name === ".npmrc");
  if (!npmrc) throw new Error("Claude Code bootstrap is missing .npmrc");

  mkdirSync(packRoot, { recursive: true });
  // Also safe when called again after an interrupted build.
  rmSync(join(packRoot, ".npmrc"), { force: true });
  for (const file of files) {
    if (file.name !== ".npmrc") {
      writeFileSync(join(packRoot, file.name), file.content);
    }
  }
  writeFileSync(join(packRoot, "bootstrap.json"), JSON.stringify(bootstrap));
  await installDependencies();
  writeFileSync(join(packRoot, ".npmrc"), npmrc.content);
  return { bridgeDigest: `sha256:${sha256File(join(packRoot, "bridge.mjs"))}` };
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
  const manifestPath = join(sdkDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
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
 * Remove what the pack must not carry. The `@anthropic-ai/claude-code`
 * wrapper exists only for the adapter's `--version` probe, which the
 * translator answers as a no-op; the SDK resolves its OWN platform package.
 */
export function prunePack(packRoot) {
  const scope = join(packRoot, "node_modules/@anthropic-ai");
  for (const entry of readdirSync(scope)) {
    if (entry === "claude-code" || entry.startsWith("claude-code-")) {
      rmSync(join(scope, entry), { recursive: true, force: true });
    }
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

/** The pinned adapter's version, as recorded in the pack manifest. */
export function adapterVersion() {
  const required = createRequire(import.meta.url);
  return JSON.parse(
    readFileSync(required.resolve("@ai-sdk/harness-claude-code/package.json"), "utf8"),
  ).version;
}

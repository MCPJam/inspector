// The Codex runtime pack recipe: everything about building a pack that is
// specific to Codex on MCPJam's app-server adapter. The generic orchestration
// — bundled Node, the Windows Job Object launcher, link flattening, the tree
// digest, archiving, signing — is `build-local-harness-pack.mjs`, shared by
// every harness. This file is a pack input of the Codex pack ONLY, so editing
// it never changes Claude Code's fingerprint.
//
// What goes in a Codex pack:
//   - MCPJam's app-server bootstrap recipe (`package.json`, `pnpm-lock.yaml`,
//     `bridge.mjs`, `host-tools-mcp.mjs`) — byte-identical to the recipe the
//     application builds, because the bridge bundle is REBUILT here from the
//     reviewed sources rather than taken from whatever generated file happens
//     to be on disk. The supervised provider byte-compares the bridge at
//     session start, so a single changed byte fails the session closed;
//   - a hoisted, symlink-free `node_modules` with the `@openai/codex` wrapper
//     (`bin/codex.js` is what the bridge runs) and EXACTLY one platform
//     package, every file of which is checked against the checksums recorded
//     from the published tarballs (`codex-vendor-checksums.json`).
//
// THE RULE THIS IMPLIES: any change under `server/utils/harness/codex-appserver/`
// that reaches the bundle changes `bridge.mjs`, so it needs a Codex pack bump
// (and the data PR recording the new digests) before it can ship to local
// users. The release check compares the published manifest's `bridgeDigest`
// with the one the Inspector was built with, so a forgotten bump is caught
// before release rather than as a failed session on someone's machine.
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

/** Every TypeScript source directly in one adapter directory, repo-relative. */
function adapterSources(subdir) {
  const dir = join(repoRoot, ADAPTER_DIR, subdir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => `${ADAPTER_DIR}/${subdir}/${name}`);
}

/**
 * Repo-relative sources whose bytes shape this recipe: the bundled bridge's
 * sources, the bundler, the bootstrap package and lockfile, and the vendor
 * checksums. The recipe's EMITTED bytes are fingerprinted too; these are
 * listed so a change to what produces them is visible in the input diff
 * rather than only in its output.
 */
export const recipeSources = [
  `${ADAPTER_DIR}/codex-appserver-bootstrap.ts`,
  `${ADAPTER_DIR}/bootstrap/package.json`,
  `${ADAPTER_DIR}/bootstrap/pnpm-lock.yaml`,
  ...adapterSources("bridge"),
  ...adapterSources("shared"),
  "mcpjam-inspector/scripts/bundle-codex-appserver-bridge.mjs",
  "mcpjam-inspector/scripts/local-harness-pack-recipes/codex-vendor-checksums.json",
];

/**
 * Packages whose locked closure (from the repo's package-lock) produces this
 * pack: the bridge kit the bundle inlines, and the bundler that inlines it.
 * An `@ai-sdk/harness` bump changes `bridge.mjs` without touching any file
 * above, so without it here a bump would leave the fingerprint unchanged.
 */
export const dependencyRoots = ["@ai-sdk/harness", "esbuild"];

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
 * The bootstrap recipe exactly as the application builds it.
 *
 * The bridge bundle is regenerated first: `bridge.mjs` is a build product of
 * the sources in `recipeSources`, and a pack built from a stale generated file
 * would carry a bridge nobody reviewed. Loaded through tsx only when asked for,
 * so importing this module (for its dependency roots, say) stays independent
 * of TypeScript and of esbuild.
 */
export async function loadRecipe() {
  const { bundleCodexAppServerBridge } = await import(
    "../bundle-codex-appserver-bridge.mjs"
  );
  await bundleCodexAppServerBridge();
  const { tsImport } = await import("tsx/esm/api");
  const { getCodexAppServerBootstrap } = await tsImport(
    "../../server/utils/harness/codex-appserver/codex-appserver-bootstrap.ts",
    { parentURL: import.meta.url, tsconfig: false },
  );
  const bootstrap = getCodexAppServerBootstrap();
  return { bootstrapDir: bootstrap.bootstrapDir, files: bootstrap.files, bootstrap };
}

/**
 * Stage exactly the recipe the application writes, then install its frozen
 * graph. `bootstrap.json` is what a local session reads its recipe from
 * (`pack-bootstrap.ts`), so it is the recipe itself, not a summary of it.
 */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files: recipeFiles, bootstrap } = await loadRecipe();
  const prefix = `${bootstrapDir}/`;
  mkdirSync(packRoot, { recursive: true });
  for (const file of recipeFiles) {
    const name = file.path.slice(prefix.length);
    if (
      !file.path.startsWith(prefix) ||
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      throw new Error(`Unexpected Codex bootstrap path: ${file.path}`);
    }
    writeFileSync(join(packRoot, name), file.content);
  }
  for (const required of ["bridge.mjs", "host-tools-mcp.mjs", "pnpm-lock.yaml"]) {
    if (!existsSync(join(packRoot, required))) {
      throw new Error(`Codex bootstrap is missing ${required}`);
    }
  }
  writeFileSync(join(packRoot, "bootstrap.json"), JSON.stringify(bootstrap));
  await installDependencies();
  return { bridgeDigest: `sha256:${sha256File(join(packRoot, "bridge.mjs"))}` };
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
 * Remove what the pack must not carry, then scan the `@openai` scope: after
 * pruning, the wrapper and THIS target's platform package are the only
 * things allowed in it. Anything else is a vendor binary no checksum covers.
 */
export function prunePack(packRoot, platformKey) {
  const scope = join(packRoot, "node_modules", "@openai");
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
  const ws = join(packRoot, "node_modules", "ws", "package.json");
  if (existsSync(ws)) packages.ws = JSON.parse(readFileSync(ws, "utf8")).version;
  return packages;
}

/**
 * The adapter identity recorded in the pack manifest: the app-server bundle
 * version plus the pinned CLI — the same string the compatibility manifest
 * pins (`CODEX_LOCAL_ADAPTER_IDENTITY`), so the two compare like for like.
 * Read from the generated bundle, which `loadRecipe()` regenerates; the build
 * asks for it only after staging.
 */
export function adapterVersion() {
  const generated = join(
    repoRoot,
    ADAPTER_DIR,
    "bootstrap/generated/codex-appserver-bridge.bundled.ts",
  );
  if (!existsSync(generated)) {
    throw new Error(
      "the Codex bridge bundle has not been generated; run " +
        "scripts/bundle-codex-appserver-bridge.mjs (the pack build does)",
    );
  }
  const bundleVersion = /export const CODEX_APPSERVER_BUNDLE_VERSION = "([0-9a-f]+)"/.exec(
    readFileSync(generated, "utf8"),
  )?.[1];
  if (!bundleVersion) {
    throw new Error("could not read CODEX_APPSERVER_BUNDLE_VERSION from the generated bundle");
  }
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, ADAPTER_DIR, "bootstrap/package.json"), "utf8"),
  );
  const cli = pkg.dependencies?.["@openai/codex"];
  if (typeof cli !== "string") {
    throw new Error("the Codex bootstrap package pins no @openai/codex version");
  }
  return `app-server/${bundleVersion}+@openai/codex@${cli}`;
}

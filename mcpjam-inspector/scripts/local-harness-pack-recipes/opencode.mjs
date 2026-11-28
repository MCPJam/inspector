// The OpenCode runtime pack recipe: everything about building a pack that is
// specific to OpenCode. The generic orchestration (bundled Node, the Windows
// Job Object launcher, link flattening, the tree digest, archiving, signing)
// is `build-local-harness-pack.mjs`, shared by every harness. This file is a
// pack input of the OpenCode pack ONLY.
//
// What goes in an OpenCode pack, VENDOR BYTES ONLY:
//   - a hoisted, symlink-free `node_modules` with EXACTLY one OpenCode build
//     (`opencode-<os>-<arch>`, the binary `opencode-ai`'s installer would
//     copy) and EXACTLY one ripgrep build (`@vscode/ripgrep-<platform>`, which
//     OpenCode searches with), every file of both checked against the
//     checksums recorded from the published tarballs
//     (`opencode-vendor-checksums.json`);
//   - `@opencode-ai/sdk`, which the bridge imports to start and drive the CLI
//     it is released with, `@vscode/ripgrep`, which names ripgrep's path, and
//     their JavaScript dependencies;
//   - `bin/node` and, on Windows, the Job Object launcher (the shared build).
//
// What does NOT: the adapter's bridge and its host-tool MCP entrypoint, with
// `ws`, the MCP SDK and `zod` compiled in, and the loopback launcher. They are
// the Inspector layer, shipped with the Inspector. Nor `opencode-ai` itself:
// its only executable is a placeholder that its install script replaces with
// the platform build, and the pack carries that build directly.
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

export const harnessId = "opencode";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR_NAME = "opencode-vendor";
const VENDOR_DIR = join(here, VENDOR_DIR_NAME);
const INSTALL_FILES = ["package.json", "pnpm-lock.yaml"];

/**
 * Repo-relative sources whose bytes shape this pack: the vendor graph's
 * manifest and frozen lockfile, and the checksums every platform file is
 * checked against. Nothing about the bridge.
 */
export const recipeSources = [
  ...INSTALL_FILES.map((name) => `mcpjam-inspector/scripts/local-harness-pack-recipes/${VENDOR_DIR_NAME}/${name}`),
  "mcpjam-inspector/scripts/local-harness-pack-recipes/opencode-vendor-checksums.json",
];

/** None: the vendor graph comes from the frozen lockfile above. */
export const dependencyRoots = [];

/** Pack target to the two platform packages it carries. */
const PLATFORM_PACKAGES = {
  "darwin-arm64": { opencode: "opencode-darwin-arm64", ripgrep: "@vscode/ripgrep-darwin-arm64" },
  "darwin-x64": { opencode: "opencode-darwin-x64", ripgrep: "@vscode/ripgrep-darwin-x64" },
  "linux-x64": { opencode: "opencode-linux-x64", ripgrep: "@vscode/ripgrep-linux-x64" },
  "linux-arm64": { opencode: "opencode-linux-arm64", ripgrep: "@vscode/ripgrep-linux-arm64" },
  "win32-x64": { opencode: "opencode-windows-x64", ripgrep: "@vscode/ripgrep-win32-x64" },
};

/** What a pack's `node_modules` may hold besides the target's OpenCode build:
 *  the SDK, ripgrep's scope and the SDK's `cross-spawn` with its dependencies. */
const ALLOWED_PACKAGES = ["@opencode-ai", "@vscode", "cross-spawn", "isexe", "path-key", "shebang-command", "shebang-regex", "which"];

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
  return JSON.parse(readFileSync(join(here, "opencode-vendor-checksums.json"), "utf8"));
}

/** The versions the vendor manifest pins, by package name. */
export function vendorPins() {
  const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, "package.json"), "utf8"));
  return { ...manifest.dependencies, ...manifest.optionalDependencies };
}

function installedVersion(packRoot, name) {
  return JSON.parse(readFileSync(join(packRoot, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
}

/** The files the pack build installs the vendor graph from, read straight
 *  from the repository. Nothing is generated. */
export async function loadRecipe() {
  const bootstrapDir = ".harness-bootstrap/opencode";
  const files = INSTALL_FILES.map((name) => ({
    path: `${bootstrapDir}/${name}`,
    content: readFileSync(join(VENDOR_DIR, name), "utf8"),
  }));
  return { bootstrapDir, files };
}

/** Install the frozen vendor graph, then remove the install manifests. */
export async function stageRecipe(packRoot, installDependencies) {
  const { bootstrapDir, files } = await loadRecipe();
  mkdirSync(packRoot, { recursive: true });
  for (const file of files) {
    writeFileSync(join(packRoot, file.path.slice(bootstrapDir.length + 1)), file.content);
  }
  await installDependencies();
  for (const name of [...INSTALL_FILES, ".npmrc"]) rmSync(join(packRoot, name), { force: true });
  return {};
}

/** Check one platform package, every file, against its recorded checksums. */
function verifyPlatformPackage(packRoot, name, expected) {
  const dir = join(packRoot, "node_modules", ...name.split("/"));
  if (!existsSync(dir)) {
    throw new Error(
      `no ${name} in the pack. pnpm installs the platform build matching the ` +
        `build host, so a pack for this target must be built on it.`,
    );
  }
  const actualFiles = walkFiles(dir);
  const expectedFiles = Object.keys(expected.files).sort();
  const missing = expectedFiles.filter((path) => !actualFiles.includes(path));
  const extra = actualFiles.filter((path) => !expectedFiles.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${name} does not match its recorded file list ` +
        `(missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  for (const path of expectedFiles) {
    const record = expected.files[path];
    const absolute = join(dir, path);
    const actualSha = sha256File(absolute);
    const want = String(record.sha256).replace(/^sha256[:-]/, "");
    if (actualSha !== want) {
      throw new Error(`checksum mismatch for ${name}/${path}: recorded ${want}, file hashes to ${actualSha}`);
    }
    const size = statSync(absolute).size;
    if (size !== record.bytes) {
      throw new Error(`size mismatch for ${name}/${path}: recorded ${record.bytes}, file is ${size}`);
    }
    // The exec bit only means something where the build host keeps it.
    if (process.platform !== "win32" && typeof record.mode === "string") {
      const executable = (statSync(absolute).mode & 0o111) !== 0;
      const recordedExecutable = (Number.parseInt(record.mode, 8) & 0o111) !== 0;
      if (executable !== recordedExecutable) {
        throw new Error(`mode mismatch for ${name}/${path}: recorded ${record.mode}`);
      }
    }
  }
  return dir;
}

/**
 * Check the SDK, ripgrep's wrapper and both platform builds are the pinned
 * versions, then every file of the target's OpenCode and ripgrep builds
 * against the checksums recorded from their published tarballs: a missing
 * file, an extra one, a different hash, size or exec bit fails the build
 * rather than shipping something nobody vouched for.
 */
export function verifyVendorBinary(packRoot, platformKey) {
  const packages = PLATFORM_PACKAGES[platformKey];
  if (packages === undefined) throw new Error(`no OpenCode build is known for ${platformKey}`);
  const recorded = vendorChecksums()[platformKey];
  if (!recorded?.[packages.opencode]?.files || !recorded?.[packages.ripgrep]?.files) {
    throw new Error(
      `opencode-vendor-checksums.json records nothing for ${platformKey}; ` +
        `refusing to ship a vendor package nothing vouches for`,
    );
  }
  const pins = vendorPins();
  for (const name of ["@opencode-ai/sdk", "@vscode/ripgrep", packages.opencode]) {
    const installed = installedVersion(packRoot, name);
    if (installed !== pins[name]) {
      throw new Error(`${name} ${installed} is installed but the recipe pins ${pins[name]}`);
    }
  }
  for (const name of [packages.opencode, packages.ripgrep]) {
    const spec = `${name}@${installedVersion(packRoot, name)}`;
    if (spec !== recorded[name].spec) {
      throw new Error(`the checksums were recorded for ${recorded[name].spec}, not this recipe's ${spec}`);
    }
    verifyPlatformPackage(packRoot, name, recorded[name]);
  }
  const binary = Object.keys(recorded[packages.opencode].files).find((path) => /^bin\/opencode(\.exe)?$/.test(path));
  if (binary === undefined) throw new Error(`the recorded file list for ${platformKey} names no opencode binary`);
  const binaryPath = join(packRoot, "node_modules", packages.opencode, binary);
  return {
    path: relative(packRoot, binaryPath).split(sep).join("/"),
    sha256: sha256File(binaryPath),
    bytes: statSync(binaryPath).size,
  };
}

/**
 * Drop other platforms' builds, then scan what is left: one OpenCode build,
 * the SDK, and ripgrep's wrapper with this target's build, beside the SDK's
 * JavaScript dependencies. Anything else is code no pin covers.
 */
export function prunePack(packRoot, platformKey) {
  const modules = join(packRoot, "node_modules");
  const packages = platformKey === undefined ? undefined : PLATFORM_PACKAGES[platformKey];
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith("opencode-") && entry !== packages?.opencode) {
      rmSync(join(modules, entry), { recursive: true, force: true });
    }
  }
  const vscode = join(modules, "@vscode");
  const ripgrepBuild = packages?.ripgrep.slice("@vscode/".length);
  for (const entry of readdirSync(vscode)) {
    if (entry.startsWith("ripgrep-") && entry !== ripgrepBuild) {
      rmSync(join(vscode, entry), { recursive: true, force: true });
    }
  }
  const scopes = { "@opencode-ai": ["sdk"], "@vscode": ["ripgrep", ...(ripgrepBuild ? [ripgrepBuild] : [])] };
  for (const [scope, allowed] of Object.entries(scopes)) {
    const unexpected = readdirSync(join(modules, scope)).filter((entry) => !allowed.includes(entry));
    if (unexpected.length > 0) throw new Error(`unexpected packages in the pack's ${scope} scope: ${unexpected.join(", ")}`);
  }
  const strays = readdirSync(modules).filter(
    (entry) => !ALLOWED_PACKAGES.includes(entry) && entry !== packages?.opencode && !entry.startsWith("."),
  );
  if (strays.length > 0) {
    throw new Error(
      `unexpected packages in the OpenCode pack's node_modules: ${strays.join(", ")} ` +
        `(an OpenCode pack carries the CLI, its SDK, ripgrep and their JavaScript dependencies only)`,
    );
  }
}

/** Exact vendor package versions actually in the pack, for its manifest. */
export function vendorPackages(packRoot) {
  const packages = {};
  const modules = join(packRoot, "node_modules");
  const names = [
    ...readdirSync(modules).filter((entry) => entry.startsWith("opencode-")),
    ...["@opencode-ai", "@vscode"].flatMap((scope) =>
      existsSync(join(modules, scope)) ? readdirSync(join(modules, scope)).map((entry) => `${scope}/${entry}`) : [],
    ),
  ];
  for (const name of names.sort()) {
    const pkg = join(modules, ...name.split("/"), "package.json");
    if (existsSync(pkg)) packages[name] = JSON.parse(readFileSync(pkg, "utf8")).version;
  }
  return packages;
}

/** The identity recorded in the pack manifest: the pinned CLI and SDK. The
 *  bridge is the Inspector layer's, pinned by the layer digest. */
export function adapterVersion() {
  const pins = vendorPins();
  const cli = pins["opencode-linux-x64"];
  for (const name of Object.values(PLATFORM_PACKAGES).map(({ opencode }) => opencode)) {
    if (pins[name] !== cli) throw new Error(`the OpenCode vendor manifest pins ${name} ${pins[name]}, not ${cli}`);
  }
  if (typeof cli !== "string" || typeof pins["@opencode-ai/sdk"] !== "string") {
    throw new Error("the OpenCode vendor manifest pins no CLI or SDK version");
  }
  return `opencode@${cli}+@opencode-ai/sdk@${pins["@opencode-ai/sdk"]}`;
}

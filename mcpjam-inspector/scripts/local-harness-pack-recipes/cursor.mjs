// The Cursor CLI runtime pack recipe: everything about building a pack that
// is specific to Cursor. The generic orchestration (bundled Node, the Windows
// Job Object launcher, link flattening, the tree digest, archiving, signing)
// is `build-local-harness-pack.mjs`, shared by every harness. This file is a
// pack input of the Cursor pack ONLY.
//
// What goes in a Cursor pack, VENDOR BYTES ONLY:
//   - `node_modules/@anysphere/agent-cli-runtime/`: Cursor's own package for
//     the target, exactly as Cursor publishes it for the pinned build
//     (`index.js`, its own Node, ripgrep and native modules). It is not on
//     npm: Cursor's installer downloads it from `downloads.cursor.com`, and so
//     does this recipe, refusing the archive unless its size and SHA-256 match
//     `cursor-vendor-checksums.json` before a byte of it is extracted;
//   - `bin/node` and, on Windows, the Job Object launcher (the shared build).
//
// What does NOT: the ACP bridge and the loopback launcher. They are the
// Inspector layer, compiled into the Inspector.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const harnessId = "cursor";

const here = dirname(fileURLToPath(import.meta.url));

/** Where Cursor's package lands in the pack, named as its manifest names it. */
const VENDOR_PACKAGE = "@anysphere/agent-cli-runtime";
const VENDOR_DIR = ["node_modules", "@anysphere", "agent-cli-runtime"];
/** The archive's single top-level directory, on every platform. */
const ARCHIVE_ROOT = "dist-package";

/** The checksums every archive is checked against. Nothing else shapes the pack. */
export const recipeSources = [
  "mcpjam-inspector/scripts/local-harness-pack-recipes/cursor-vendor-checksums.json",
];

/** None: nothing in a Cursor pack comes from this repository's lockfile. */
export const dependencyRoots = [];

function vendorChecksums() {
  return JSON.parse(readFileSync(join(here, "cursor-vendor-checksums.json"), "utf8"));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function archiveFor(platformKey) {
  const archive = vendorChecksums().archives[platformKey];
  if (archive === undefined) {
    throw new Error(
      `cursor-vendor-checksums.json records no Cursor CLI archive for ${platformKey}; ` +
        `refusing to ship a vendor package nothing vouches for`,
    );
  }
  return archive;
}

/** No install files: the package is downloaded, not installed from a lockfile. */
export async function loadRecipe() {
  return { bootstrapDir: ".harness-bootstrap/cursor", files: [] };
}

/** Nothing to install: there is no package graph. The target's archive is
 *  fetched once the build names the target, in `verifyVendorBinary`. */
export async function stageRecipe(packRoot) {
  mkdirSync(join(packRoot, "node_modules"), { recursive: true });
  return {};
}

/**
 * Download the target's archive, refuse it unless its size and SHA-256 are
 * the recorded ones, extract it into the pack, and check it held the CLI the
 * runtime launches: Cursor's own Node and the `index.js` it runs. Built on any
 * host, since nothing here depends on the host's platform.
 */
export function verifyVendorBinary(packRoot, platformKey) {
  const archive = archiveFor(platformKey);
  const vendor = join(packRoot, ...VENDOR_DIR);
  // Beside the pack, so the extracted tree is moved by a rename on one volume.
  const scratch = mkdtempSync(join(dirname(packRoot), ".cursor-archive-"));
  try {
    const file = join(scratch, archive.url.endsWith(".zip") ? "agent-cli.zip" : "agent-cli.tar.gz");
    process.stdout.write(`[pack] downloading the Cursor CLI ${vendorChecksums().build} for ${platformKey}…\n`);
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", file, archive.url], { stdio: "inherit" });
    const bytes = statSync(file).size;
    if (bytes !== archive.bytes) {
      throw new Error(`the Cursor CLI archive for ${platformKey} is ${bytes} bytes; the recipe records ${archive.bytes}`);
    }
    const sha256 = sha256File(file);
    if (sha256 !== archive.sha256) {
      throw new Error(`the Cursor CLI archive for ${platformKey} hashes to ${sha256}; the recipe records ${archive.sha256}`);
    }
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    extract(file, extracted);
    const roots = readdirSync(extracted);
    if (roots.length !== 1 || roots[0] !== ARCHIVE_ROOT) {
      throw new Error(`the Cursor CLI archive should hold only ${ARCHIVE_ROOT}/, found ${roots.join(", ")}`);
    }
    mkdirSync(dirname(vendor), { recursive: true });
    renameSync(join(extracted, ARCHIVE_ROOT), vendor);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const node = join(vendor, platformKey.startsWith("win32") ? "node.exe" : "node");
  const entry = join(vendor, "index.js");
  for (const path of [node, entry]) {
    if (!existsSync(path)) throw new Error(`the Cursor CLI package has no ${path.slice(packRoot.length + 1)}`);
  }
  const manifest = JSON.parse(readFileSync(join(vendor, "package.json"), "utf8"));
  if (manifest.name !== VENDOR_PACKAGE) {
    throw new Error(`the Cursor CLI package is ${JSON.stringify(manifest.name)}, not ${VENDOR_PACKAGE}`);
  }
  return { path: [...VENDOR_DIR, "index.js"].join("/"), sha256: sha256File(entry), bytes: statSync(entry).size };
}

function extract(file, into) {
  if (!file.endsWith(".zip")) {
    execFileSync("tar", ["-xzf", file, "-C", into], { stdio: "inherit" });
    return;
  }
  // bsdtar reads zip (Windows 10+ and macOS ship it) and handles the package's
  // deep tree, which is why Cursor's own installer uses it too.
  try {
    execFileSync("tar", ["-xf", file, "-C", into], { stdio: "inherit" });
  } catch {
    execFileSync("unzip", ["-q", file, "-d", into], { stdio: "inherit" });
  }
}

/** Nothing to drop: the pack is Cursor's package and nothing else. */
export function prunePack(packRoot) {
  const strays = [
    ...readdirSync(packRoot).filter((entry) => entry !== "node_modules"),
    ...readdirSync(join(packRoot, "node_modules")).filter((entry) => entry !== "@anysphere").map((entry) => `node_modules/${entry}`),
    ...readdirSync(join(packRoot, "node_modules", "@anysphere"))
      .filter((entry) => entry !== "agent-cli-runtime")
      .map((entry) => `node_modules/@anysphere/${entry}`),
  ];
  if (strays.length > 0) {
    throw new Error(`unexpected entries in the Cursor pack: ${strays.join(", ")} (a Cursor pack carries Cursor's package only)`);
  }
}

/** The pinned build and the exact dependencies Cursor's package declares. */
export function vendorPackages(packRoot) {
  const manifest = join(packRoot, ...VENDOR_DIR, "package.json");
  const dependencies = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}) : {};
  return { [VENDOR_PACKAGE]: vendorChecksums().build, ...dependencies };
}

/** The identity recorded in the pack manifest: the pinned Cursor CLI build.
 *  The bridge is the Inspector layer's, pinned by the layer digest. */
export function adapterVersion() {
  return `cursor-agent@${vendorChecksums().build}`;
}

// Which harnesses a runtime pack can be built for, and what each pack is
// called once it is.
//
// ── Why this is a directory listing and not a table ──────────────────────
// Every pack's input fingerprint covers the SHARED build machinery — this
// file included. A hand-maintained list of harnesses here would therefore put
// "Codex exists" into Claude Code's fingerprint, and adding or editing the
// Codex recipe would force a Claude Code re-publication for bytes that cannot
// change its pack. So a harness is registered by dropping a recipe module into
// `local-harness-pack-recipes/<harnessId>.mjs`, and this module only knows the
// generic rules: how to find a recipe, and how a pack release and its assets
// are named.
//
// The naming rules have exactly one special case, and it is a COMPATIBILITY
// one: Claude Code's pack shipped first, under `local-harness-pack-v<ver>` and
// `local-harness-pack-<target>-<ver>.*`, and Inspectors already pinned to
// those URLs must keep finding them. Every other harness carries its id in the
// tag and the asset names, so two harnesses can never collide on a version.
// `server/utils/harness/local/pack-naming.ts` is the TypeScript twin of these
// two functions; `pack-naming.test.ts` pins them to each other.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Where recipe modules live. One file per harness, named by its id. */
export const PACK_RECIPES_DIR = join(scriptDir, "local-harness-pack-recipes");

/** The harness whose pack predates per-harness names. */
const LEGACY_NAMED_HARNESS = "claude-code";

const HARNESS_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** A pack release's git tag. */
export function packReleaseTag(harnessId, packVersion) {
  assertHarnessId(harnessId);
  return harnessId === LEGACY_NAMED_HARNESS
    ? `local-harness-pack-v${packVersion}`
    : `local-harness-pack-${harnessId}-v${packVersion}`;
}

/** The stem every asset of one target's pack shares. */
export function packAssetStem(harnessId, target, packVersion) {
  assertHarnessId(harnessId);
  return harnessId === LEGACY_NAMED_HARNESS
    ? `local-harness-pack-${target}-${packVersion}`
    : `local-harness-pack-${harnessId}-${target}-${packVersion}`;
}

/** The release download base for a harness's pack version. */
export function packReleaseBaseUrl(harnessId, packVersion) {
  return (
    "https://github.com/MCPJam/inspector/releases/download/" +
    `${packReleaseTag(harnessId, packVersion)}/`
  );
}

function assertHarnessId(harnessId) {
  if (typeof harnessId !== "string" || !HARNESS_ID.test(harnessId)) {
    throw new Error(`not a harness id: ${JSON.stringify(harnessId)}`);
  }
}

/**
 * The harnesses with a recipe, sorted. Read from disk every call: this is
 * build and release tooling, not a hot path, and a stale cache is a way to
 * check one harness while believing you checked them all.
 */
export function listPackHarnessIds(recipesDir = PACK_RECIPES_DIR) {
  return readdirSync(recipesDir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.slice(0, -".mjs".length))
    .filter((id) => HARNESS_ID.test(id))
    .sort();
}

/** Repo-relative path of a harness's recipe module (a pack input). */
export function packRecipeModulePath(harnessId) {
  assertHarnessId(harnessId);
  return `mcpjam-inspector/scripts/local-harness-pack-recipes/${harnessId}.mjs`;
}

/**
 * Load one recipe, refusing an id that has none rather than importing
 * whatever a path built from it happens to resolve to.
 */
export async function loadPackHarness(harnessId, recipesDir = PACK_RECIPES_DIR) {
  assertHarnessId(harnessId);
  const known = listPackHarnessIds(recipesDir);
  if (!known.includes(harnessId)) {
    throw new Error(
      `no runtime pack recipe for ${harnessId} (known: ${known.join(", ") || "none"})`,
    );
  }
  const recipe = await import(
    pathToFileURL(join(recipesDir, `${harnessId}.mjs`)).href
  );
  if (recipe.harnessId !== harnessId) {
    throw new Error(
      `recipe ${harnessId}.mjs declares harnessId ${JSON.stringify(recipe.harnessId)}`,
    );
  }
  for (const name of [
    "loadRecipe",
    "stageRecipe",
    "verifyVendorBinary",
    "prunePack",
    "vendorPackages",
    "adapterVersion",
  ]) {
    if (typeof recipe[name] !== "function") {
      throw new Error(`recipe ${harnessId}.mjs does not export ${name}()`);
    }
  }
  for (const name of ["recipeSources", "dependencyRoots"]) {
    if (!Array.isArray(recipe[name])) {
      throw new Error(`recipe ${harnessId}.mjs does not export ${name}[]`);
    }
  }
  return recipe;
}

/**
 * The pre-baked harness template, from the inspector's side.
 *
 * WHY THIS EXISTS. Every hosted harness turn used to install its runtime at
 * TURN time: the framework writes the adapter's bootstrap recipe into the box
 * and runs `pnpm install` against it before the first prompt. On a fresh box
 * that is minutes of wall clock, and it ran against whatever the base image and
 * the package registry happened to serve that day — which has already broken
 * hosted turns twice (pnpm 11 reading none of `.npmrc`, and a deny-all egress
 * baseline that could not reach the registry at all).
 *
 * The computer template (mcpjam-backend `templates/computer/`) now installs the
 * recipes at IMAGE BUILD time, from a bake context this repository generates
 * (`scripts/harness-bake-context.mjs`). No harness change is needed for that to
 * take effect: `applyBootstrapRecipe` in `@ai-sdk/harness` skips the install
 * when `<defaultWorkingDirectory>/<bootstrapDir>/.bootstrap-<identity>.ok`
 * already exists. What has to hold is that the identity the TEMPLATE baked is
 * the identity THIS inspector computes for the recipe it hands the framework —
 * which is why the identity function lives here, imported by both the bake
 * context generator and the observer that reports whether a turn actually hit
 * the bake (`harness-bake-observer.ts`).
 *
 * WHAT A MISS MEANS. A box whose working directory is not `/home/user`, a
 * custom environment image and a template built from an older bake all miss
 * the marker, and the framework
 * falls back to installing — the turn still works, it is just slow. The
 * phase-timing log line says which of those it was (see
 * `harnessBootstrapLogFields`), so intentional fallback can be told apart
 * from template or pin drift.
 *
 * WHAT CATCHES DRIFT. `harness-bake.lock.json` records the recipe identities
 * the computer template is expected to carry, and `harness-bake.test.ts`
 * fails when a recipe change moves an identity without the lock being
 * updated. Updating the lock is the reviewable signal that the template has
 * to be rebuilt from that commit; nothing in CI can check that the rebuilt
 * template was actually rolled out. At runtime every hosted turn reports its
 * bootstrap (`[harness][timing]` on success, `[harness][bootstrap]` on
 * failure), and the bake-miss monitor (mcpjam-backend `ops/axiom-monitors`)
 * watches both, grouped by whether the box carries a bake at all.
 *
 * Everything here is a constant on purpose: the template, the generator and
 * the observer must agree on these values, so none of them is configurable.
 *
 * Kept free of server dependencies: the bake context generator imports it
 * through tsx in a bare Node.
 */
import { createHash } from "node:crypto";

/** The box home the template bakes into — E2B's default working directory. */
export const HARNESS_BAKE_HOME = "/home/user";

/**
 * Bake manifest on a baked box. Its PRESENCE is what tells a box built from a
 * baked template (a miss there is drift) from one that is not (an older
 * template or a custom environment image — a miss there is expected).
 */
export const HARNESS_BAKE_MANIFEST_PATH = `${HARNESS_BAKE_HOME}/.harness-bootstrap/manifest.json`;

/**
 * Bootstrap directories (relative to the working directory) the template
 * bakes: the PATCHED Claude Code recipe, the Codex app-server recipe and the
 * Cursor recipe. Cursor became bakeable when its CLI install was PINNED to a
 * checksummed build (`cursor-bootstrap.ts`); before that its bootstrap fetched
 * whatever `cursor.com/install` served and could only ever install at turn time.
 */
export const HARNESS_BAKED_BOOTSTRAP_DIRS: ReadonlyArray<string> = [
  ".harness-bootstrap/claude-code",
  ".harness-bootstrap/codex-appserver",
  ".harness-bootstrap/cursor",
];

/**
 * `bakedBy` value in a marker the template wrote. The framework only checks
 * that the marker EXISTS and writes an empty one itself, so the template's
 * marker carries one JSON line instead — `{ bakedBy, harnessId, identity,
 * bakeId, versions }` (`scripts/harness-bake/bake.mjs`) — which is how a turn
 * tells a baked box from one an earlier turn installed, and learns what the
 * template baked without any extra read.
 */
export const HARNESS_BAKED_MARKER_AUTHOR = "mcpjam-harness-bake";

/**
 * The toolchain the template pins and the bake is verified against. Node is
 * equal to `scripts/local-harness-toolchain.json` (asserted in
 * `harness-bake.test.ts`), the toolchain the local packs and the conformance
 * suite run on.
 *
 * pnpm is NOT: a hosted box has 1 GiB of memory, and pnpm 10 holds the Claude
 * Code and Agent SDK native binaries (~392 MB unpacked each) in memory while
 * extracting them, so the bake's `pnpm install` is OOM-killed there (974 MB
 * peak on a live 1 GiB box). pnpm 12 streams them (638 MB peak) and is what
 * the unpinned templates already ran. Local packs build on machines without
 * that limit and keep the toolchain file's pnpm.
 */
export const HARNESS_TEMPLATE_NODE_VERSION = "24.20.0";
export const HARNESS_TEMPLATE_PNPM_VERSION = "12.8.1";

/**
 * The idempotent pnpm guard a provider runs before the framework's bootstrap.
 *
 * PINNED. The fallback used to be a bare `npm install -g pnpm`, so a box
 * without pnpm — a custom environment image, an old template — got whatever
 * pnpm was current, which is how pnpm 11 reached hosted turns. The baked
 * template already has this exact version, so on it this is `command -v` only.
 */
export function harnessPnpmGuardCommand(): string {
  return `command -v pnpm || npm install -g pnpm@${HARNESS_TEMPLATE_PNPM_VERSION}`;
}

/** The recipe shape the framework hashes (`HarnessV1Bootstrap`). */
export interface HarnessBootstrapRecipe {
  harnessId: string;
  bootstrapDir: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  commands: ReadonlyArray<{ command: string }>;
}

/**
 * `@ai-sdk/harness`'s recipe identity (`hashHarnessBootstrap`,
 * `src/agent/internal/bootstrap-recipe.ts`), reproduced byte for byte because
 * the package does not export it: SHA-256 over NUL-terminated fields — harness
 * id, bootstrap dir, each file's path and content in `localeCompare` order, the
 * JSON of the commands and the schema version — truncated to 16 hex chars.
 *
 * `harness-bake.test.ts` proves this equals what the real framework puts in
 * the marker path, so a framework bump that changes the scheme fails CI rather
 * than silently turning every baked box back into an installing one.
 */
const HARNESS_BOOTSTRAP_SCHEMA_VERSION = 1;
export function harnessRecipeIdentity(recipe: HarnessBootstrapRecipe): string {
  const hash = createHash("sha256");
  const push = (value: string) => {
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  };
  push(recipe.harnessId);
  push(recipe.bootstrapDir);
  const files = [...recipe.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    push(file.path);
    push(file.content);
  }
  push(JSON.stringify(recipe.commands));
  push(String(HARNESS_BOOTSTRAP_SCHEMA_VERSION));
  return hash.digest("hex").slice(0, 16);
}

/** The marker file name the framework checks for a recipe identity. */
export function harnessBootstrapMarkerName(identity: string): string {
  return `.bootstrap-${identity}.ok`;
}

type BakedMarker = {
  bakedBy?: unknown;
  bakeId?: unknown;
  versions?: unknown;
};

/** Parse a marker the TEMPLATE wrote; null for the framework's empty marker
 *  or anything else. */
export function parseBakedMarker(
  content: string,
): { bakeId?: string; versions?: string } | null {
  try {
    const parsed = JSON.parse(content) as BakedMarker;
    if (parsed?.bakedBy !== HARNESS_BAKED_MARKER_AUTHOR) return null;
    const versions =
      parsed.versions && typeof parsed.versions === "object"
        ? Object.entries(parsed.versions as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string" && v.length > 0)
            .map(([k, v]) => `${k}@${v as string}`)
            .sort()
            .join(",")
        : undefined;
    return {
      ...(typeof parsed.bakeId === "string" ? { bakeId: parsed.bakeId } : {}),
      ...(versions ? { versions } : {}),
    };
  } catch {
    return null;
  }
}

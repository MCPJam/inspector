/**
 * WHERE A RUN CAME FROM — one rule, one label table, read by the badge, the
 * filter chips, and the run-history line.
 *
 * The problem this solves: `testSuiteRun.source` is stamped by the server at
 * the boundary the run entered by, which makes it trustworthy and makes it
 * coarse. Everything that reaches the platform through `/api/v1` is `api` — the
 * `mcpjam` CLI, a GitHub Action running the CLI, an MCP agent driving the
 * platform tools — so the Runs table said `API` six ways and answered nobody's
 * question.
 *
 * Origin is therefore resolved from THREE columns, in a fixed precedence:
 *
 *   1. `attribution.surface` — VERIFIED, minted onto the credential rather than
 *      sent by the caller. Only the three agent channels the platform can
 *      actually prove (`mcp`, `slack`, `discord`) outrank anything; `rest` is
 *      deliberately excluded, because it is what a plain API call mints and
 *      would overwrite every honest CLI label with `API`.
 *   2. `launcher.kind` — DECLARED by the launching client. Precise, and
 *      self-reported, so it loses to proof and wins over a coarse stamp.
 *   3. `source` — STAMPED. Always present (barring rows that predate it), never
 *      wrong, and often too general to be useful on its own.
 *
 * Three consequences worth stating, because each of them is a bug someone
 * would otherwise reintroduce:
 *
 *   * A CLI run answers to the **CLI** chip and NOT to **API**. Otherwise the
 *     API chip means "everything that used an API key", which is every CLI,
 *     Action and MCP run — and stops answering the only question it is good
 *     for ("a script of mine called the API directly").
 *   * The chip and the badge share this function, so a row can never be
 *     labelled one thing and filtered as another.
 *   * The FILTER now runs server-side (`listProjectRuns`'s `origins` arg), and
 *     the backend re-implements this precedence as a query pushdown so a page
 *     is a page of matching runs. Its own tests check the two against each
 *     other. If you change the rule here, change it there.
 */

/** The origins a run can resolve to. Two of them are verified-only. */
export const RUN_ORIGINS = [
  "cli",
  "mcp",
  "github",
  "sdk",
  "schedule",
  "ui",
  "api",
  "slack",
  "discord",
] as const;

export type RunOrigin = (typeof RUN_ORIGINS)[number];

/**
 * The chips the Runs table offers — every origin, no exceptions.
 *
 * `slack` and `discord` are reachable only as VERIFIED surfaces (nothing can
 * declare either), which is a reason they are rare, not a reason to leave them
 * out: a label a reader can SEE on a row and cannot filter by is the exact
 * complaint this work started from. The server-side filter already expresses
 * them, so a chip costs nothing but the chip.
 */
export const RUN_ORIGIN_FILTERS: readonly RunOrigin[] = [...RUN_ORIGINS];

export type RunOriginMeta = {
  label: string;
  /**
   * WHAT the origin is, with no claim about how we know it — the badge appends
   * that from the tier that actually won (see `resolveRunProvenance`), and the
   * chips use this sentence as-is because a chip matches every tier at once.
   */
  title: string;
  className: string;
};

/**
 * ONE table. `run-source-badge`, the chip row and `runPlatformLabel` all read
 * it, so a label can only be wrong in one place instead of three.
 *
 * Muted-outline styling throughout: these are labels on a dense row, not
 * statuses. Tints stay on backgrounds and borders at /50 so the foreground
 * keeps its contrast ratio in both themes.
 */
export const RUN_ORIGIN_META: Record<RunOrigin, RunOriginMeta> = {
  ui: {
    label: "UI",
    title: "Launched from the MCPJam app",
    className: "border-border/60 bg-muted/50 text-muted-foreground",
  },
  sdk: {
    label: "SDK",
    title: "Reported by the MCPJam SDK (CI or local test run)",
    className:
      "border-primary/50 bg-primary/10 text-foreground dark:bg-primary/15",
  },
  api: {
    label: "API",
    title: "Launched via the public /v1 API",
    className:
      "border-sky-500/50 bg-sky-500/10 text-foreground dark:bg-sky-500/15",
  },
  schedule: {
    label: "Scheduled",
    title: "Launched by a schedule",
    className:
      "border-amber-500/50 bg-amber-500/10 text-foreground dark:bg-amber-500/15",
  },
  github: {
    label: "GitHub",
    title: "Launched from GitHub — a pull-request check or an Action",
    className:
      "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
  },
  cli: {
    label: "CLI",
    title: "Launched by the mcpjam CLI",
    className:
      "border-teal-500/50 bg-teal-500/10 text-foreground dark:bg-teal-500/15",
  },
  mcp: {
    label: "MCP",
    title: "Launched by an MCP agent",
    className:
      "border-fuchsia-500/50 bg-fuchsia-500/10 text-foreground dark:bg-fuchsia-500/15",
  },
  slack: {
    label: "Slack",
    title: "Launched through the MCPJam Slack app",
    className:
      "border-emerald-500/50 bg-emerald-500/10 text-foreground dark:bg-emerald-500/15",
  },
  discord: {
    label: "Discord",
    title: "Launched through the MCPJam Discord app",
    className:
      "border-indigo-500/50 bg-indigo-500/10 text-foreground dark:bg-indigo-500/15",
  },
};

/**
 * The minimum a run row has to expose. Every field optional and read
 * defensively: an older backend sends neither `launcher` nor `attribution`,
 * and those runs must resolve exactly as they did before this existed.
 */
export type RunOriginInput = {
  source?: string | null;
  launcher?: { kind?: string | null } | null;
  attribution?: { surface?: string | null } | null;
};

/**
 * `Map`s rather than object literals, on purpose.
 *
 * These are keyed by strings off the wire, and a plain `Record` answers
 * `"constructor"` or `"toString"` with something inherited and truthy. The
 * resolver would then hand the badge a function where an origin belongs, and
 * `RUN_ORIGIN_META[fn]` is `undefined` — one unknown source string would take
 * out the whole runs table. A `Map` has no inherited keys, so an unrecognised
 * value falls through to the same place every other unrecognised value does.
 */

/** Verified surfaces that outrank a declared label. See the module note. */
const VERIFIED_ORIGIN_SURFACES = new Map<string, RunOrigin>([
  ["mcp", "mcp"],
  ["slack", "slack"],
  ["discord", "discord"],
]);

const LAUNCHER_KIND_ORIGINS = new Map<string, RunOrigin>([
  ["cli", "cli"],
  ["mcp", "mcp"],
  ["github_action", "github"],
]);

const SOURCE_ORIGINS = new Map<string, RunOrigin>([
  ["ui", "ui"],
  ["sdk", "sdk"],
  ["api", "api"],
  ["schedule", "schedule"],
  ["github_check", "github"],
]);

/**
 * Resolve one run's origin: verified, then declared, then stamped.
 *
 * Falls back to `ui` for a row that predates `source` entirely — the same
 * fallback `getRunMetricSource` and the backend's own projections use, so a
 * legacy run reads the same everywhere.
 */
export function resolveRunOrigin(run: RunOriginInput): RunOrigin {
  return resolveRunProvenance(run).origin;
}

/**
 * WHICH of the three layers answered, alongside the answer.
 *
 * The badge needs this and not just the origin: the same `MCP` label means
 * "the credential proves it" on one row and "the caller said so" on the next,
 * and a tooltip that reads the origin's identity instead of the layer that won
 * says "declared" over a verified run — asserting the opposite of the truth on
 * the one row where we actually have proof.
 */
export type RunProvenanceTier = "verified" | "declared" | "stamped";

export type RunProvenance = { origin: RunOrigin; tier: RunProvenanceTier };

export function resolveRunProvenance(run: RunOriginInput): RunProvenance {
  const verified = VERIFIED_ORIGIN_SURFACES.get(run.attribution?.surface ?? "");
  if (verified) return { origin: verified, tier: "verified" };
  const declared = LAUNCHER_KIND_ORIGINS.get(run.launcher?.kind ?? "");
  if (declared) return { origin: declared, tier: "declared" };
  // `ui` for a row that predates `source` as much as for one that says `ui`:
  // either way nobody declared anything, so the tier is what the server knows.
  return {
    origin: SOURCE_ORIGINS.get(run.source ?? "") ?? "ui",
    tier: "stamped",
  };
}

/** The label alone — for the places that render text rather than a badge. */
export function runOriginLabel(run: RunOriginInput): string {
  return RUN_ORIGIN_META[resolveRunOrigin(run)].label;
}

/**
 * "····1234" for an API key id, or `null`.
 *
 * The LAST FOUR only. The key id is not the secret, but it is still a
 * credential identifier in a shared table, and four characters are enough for
 * the one question a reader has — "which of my keys was that?" — without
 * printing something anyone could paste into a search.
 */
export function maskApiKeyId(
  apiKeyId: string | null | undefined,
): string | null {
  if (typeof apiKeyId !== "string") return null;
  const trimmed = apiKeyId.trim();
  if (trimmed.length === 0) return null;
  return `····${trimmed.slice(-4)}`;
}

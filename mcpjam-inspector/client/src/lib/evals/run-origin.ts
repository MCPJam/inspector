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
 * The chips the Runs table offers.
 *
 * `slack` and `discord` are origins but not chips: nothing can DECLARE them —
 * they exist only when a verified credential says so — and a chip that can
 * never match anything is worse than no chip. They still badge correctly when
 * a run has one.
 */
export const RUN_ORIGIN_FILTERS: readonly RunOrigin[] = [
  "cli",
  "mcp",
  "github",
  "sdk",
  "schedule",
  "ui",
  "api",
];

export type RunOriginMeta = {
  label: string;
  /** The badge's `title`; also the chip's, so both explain the same thing. */
  title: string;
  className: string;
  /** True for origins a client asserts about itself rather than the server. */
  declared: boolean;
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
    declared: false,
  },
  sdk: {
    label: "SDK",
    title: "Reported by the MCPJam SDK (CI or local test run)",
    className:
      "border-primary/50 bg-primary/10 text-foreground dark:bg-primary/15",
    declared: false,
  },
  api: {
    label: "API",
    title: "Launched via the public /v1 API",
    className:
      "border-sky-500/50 bg-sky-500/10 text-foreground dark:bg-sky-500/15",
    declared: false,
  },
  schedule: {
    label: "Scheduled",
    title: "Launched by a schedule",
    className:
      "border-amber-500/50 bg-amber-500/10 text-foreground dark:bg-amber-500/15",
    declared: false,
  },
  github: {
    label: "GitHub",
    title: "Launched from GitHub — a pull-request check or an Action",
    className:
      "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
    declared: false,
  },
  cli: {
    label: "CLI",
    title: "Declared by the launching client — the mcpjam CLI",
    className:
      "border-teal-500/50 bg-teal-500/10 text-foreground dark:bg-teal-500/15",
    declared: true,
  },
  mcp: {
    label: "MCP",
    title: "Declared by the launching client — an MCP agent",
    className:
      "border-fuchsia-500/50 bg-fuchsia-500/10 text-foreground dark:bg-fuchsia-500/15",
    declared: true,
  },
  slack: {
    label: "Slack",
    title: "Launched through the MCPJam Slack app",
    className:
      "border-emerald-500/50 bg-emerald-500/10 text-foreground dark:bg-emerald-500/15",
    declared: false,
  },
  discord: {
    label: "Discord",
    title: "Launched through the MCPJam Discord app",
    className:
      "border-indigo-500/50 bg-indigo-500/10 text-foreground dark:bg-indigo-500/15",
    declared: false,
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

/** Verified surfaces that outrank a declared label. See the module note. */
const VERIFIED_ORIGIN_SURFACES: Record<string, RunOrigin> = {
  mcp: "mcp",
  slack: "slack",
  discord: "discord",
};

const LAUNCHER_KIND_ORIGINS: Record<string, RunOrigin> = {
  cli: "cli",
  mcp: "mcp",
  github_action: "github",
};

const SOURCE_ORIGINS: Record<string, RunOrigin> = {
  ui: "ui",
  sdk: "sdk",
  api: "api",
  schedule: "schedule",
  github_check: "github",
};

/**
 * Resolve one run's origin: verified, then declared, then stamped.
 *
 * Falls back to `ui` for a row that predates `source` entirely — the same
 * fallback `getRunMetricSource` and the backend's own projections use, so a
 * legacy run reads the same everywhere.
 */
export function resolveRunOrigin(run: RunOriginInput): RunOrigin {
  const surface = run.attribution?.surface;
  if (surface && VERIFIED_ORIGIN_SURFACES[surface]) {
    return VERIFIED_ORIGIN_SURFACES[surface];
  }
  const kind = run.launcher?.kind;
  if (kind && LAUNCHER_KIND_ORIGINS[kind]) {
    return LAUNCHER_KIND_ORIGINS[kind];
  }
  return SOURCE_ORIGINS[run.source ?? ""] ?? "ui";
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

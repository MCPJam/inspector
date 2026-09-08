import type { EvalSuiteRun } from "@/components/evals/types";

/**
 * WHERE A RUN CAME FROM — one resolver, one table, every surface.
 *
 * ============================================================================
 * WHY A RUN'S ORIGIN TAKES THREE FIELDS TO ANSWER
 * ============================================================================
 *
 * `testSuiteRun.source` is STAMPED by the backend at the `/v1` boundary and is
 * deliberately not settable by a caller — which is what makes it audit truth,
 * and also what makes it useless as a badge. Everything that arrives over the
 * public API is `api`, so a CLI run, a GitHub Actions job and an MCP agent
 * showed up as three identical `API` rows. (Deriving the difference from
 * `user-agent` was tried and removed as forgeable.)
 *
 * So two more fields carry what the stamp cannot:
 *
 *   * `launcher` — DECLARED by the launching process. A claim, allowlisted to
 *     the three origins the server cannot observe for itself.
 *   * `attribution` — VERIFIED, minted by the backend from the credential the
 *     request authenticated with.
 *
 * `resolveRunOrigin` composes them in the only defensible order: verified beats
 * declared because a claim must never outrank a proof, and declared beats
 * stamped because the stamp says `api` for all three declarable launchers and
 * answers nothing anybody asked.
 *
 * ============================================================================
 * ONE TABLE, NOT THREE
 * ============================================================================
 *
 * `RUN_ORIGIN_META` is the single source for the badge, the filter chips and
 * the suite-detail label. Those were three hand-copied lists, which is how the
 * chips came to offer values the badge could not render and vice versa.
 */

/** The DECLARED launcher on a run row. */
export type RunLauncher = NonNullable<EvalSuiteRun["launcher"]>;

/** Everything a run's origin can resolve to. Mirrors the backend's `RUN_ORIGINS`. */
export type RunOrigin =
  | "ui"
  | "sdk"
  | "api"
  | "schedule"
  | "github_check"
  | "cli"
  | "mcp"
  | "github_action"
  | "slack"
  | "discord";

/**
 * The verified surfaces that outrank a declared launcher.
 *
 * Only three, because only three are MORE SPECIFIC than what the launcher
 * already says. `rest` and `cli` are what any API key looks like from the
 * token's side — promoting them would relabel a GitHub Actions run as "CLI"
 * because the CLI is what held the key. `workspace` is the app's own chat,
 * which already stamps `ui`.
 */
const PROMOTED_SURFACES = new Set(["mcp", "slack", "discord"]);

const LAUNCHER_KINDS = new Set(["cli", "mcp", "github_action"]);

/** The shape every reader here needs, so a caller can pass a narrow row. */
export type RunOriginInput = {
  source?: EvalSuiteRun["source"] | null;
  launcher?: EvalSuiteRun["launcher"] | null;
  attribution?: EvalSuiteRun["attribution"] | null;
  /**
   * The SUITE's creation provenance, for a run row that predates
   * `testSuiteRun.source`. Same fallback every other reader uses (see
   * `getRunMetricSource`).
   */
  suiteSource?: string | null;
};

/**
 * The run's origin, or `undefined` when nothing on the row says.
 *
 * Every field is read DEFENSIVELY. A backend that predates run provenance sends
 * no `launcher` and no `attribution` at all, and this resolver has to keep
 * answering `source` for those rows rather than rendering a blank cell.
 */
export function resolveRunOrigin(run: RunOriginInput): RunOrigin | undefined {
  const surface = run.attribution?.surface;
  if (typeof surface === "string" && PROMOTED_SURFACES.has(surface)) {
    return surface as RunOrigin;
  }
  const kind = run.launcher?.kind;
  if (typeof kind === "string" && LAUNCHER_KINDS.has(kind)) {
    return kind as RunOrigin;
  }
  const stamped = run.source ?? run.suiteSource;
  return typeof stamped === "string" ? (stamped as RunOrigin) : undefined;
}

export type RunOriginMeta = {
  label: string;
  title: string;
  className: string;
  /**
   * A DECLARED origin says so in its tooltip.
   *
   * Not decoration: the whole reason `source` is stamped server-side is that a
   * label a client can choose is a label nobody should rely on. A badge that
   * presented a claim and a proof identically would erase exactly that
   * distinction from the one place a person reads it.
   */
  declared?: boolean;
};

/**
 * The one table. Colour tints stay on backgrounds and borders at /50 so the
 * foreground keeps its contrast ratio in both themes — the same rule
 * `SuiteSourceBadge` follows, because this is a label on a dense row and not a
 * status.
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
  github_check: {
    label: "GitHub",
    title: "Launched by a GitHub pull-request check",
    className:
      "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
  },
  github_action: {
    label: "GitHub",
    title: "Launched from a GitHub Actions job",
    className:
      "border-violet-500/50 bg-violet-500/10 text-foreground dark:bg-violet-500/15",
    declared: true,
  },
  cli: {
    label: "CLI",
    title: "Launched by the mcpjam CLI",
    className:
      "border-teal-500/50 bg-teal-500/10 text-foreground dark:bg-teal-500/15",
    declared: true,
  },
  mcp: {
    label: "MCP",
    title: "Launched by an MCP client's agent",
    className:
      "border-fuchsia-500/50 bg-fuchsia-500/10 text-foreground dark:bg-fuchsia-500/15",
    declared: true,
  },
  slack: {
    label: "Slack",
    title: "Launched by the MCPJam Slack agent",
    className:
      "border-fuchsia-500/50 bg-fuchsia-500/10 text-foreground dark:bg-fuchsia-500/15",
  },
  discord: {
    label: "Discord",
    title: "Launched by the MCPJam Discord agent",
    className:
      "border-fuchsia-500/50 bg-fuchsia-500/10 text-foreground dark:bg-fuchsia-500/15",
  },
};

const DECLARED_SUFFIX = " — declared by the launching client";

/** The tooltip for one origin, saying whether it is a claim or a stamp. */
export function runOriginTitle(origin: RunOrigin | undefined): string {
  const meta = RUN_ORIGIN_META[origin ?? "ui"] ?? RUN_ORIGIN_META.ui;
  return meta.declared ? `${meta.title}${DECLARED_SUFFIX}` : meta.title;
}

/**
 * The filter chips, derived from the table rather than hand-copied beside it.
 *
 * `github` is the one chip that selects TWO stored values: a PR check and an
 * Actions job are the same thing to the person filtering, and were never
 * distinguishable in the badge either. The mapping is explicit here rather than
 * collapsed inside the query, so "why did I get this row" stays answerable.
 *
 * `slack` and `discord` have no chip: those runs are launched through the MCP
 * surface and already answer the MCP chip, so a separate one would be a filter
 * that almost always returns nothing.
 */
export const RUN_ORIGIN_FILTERS: Array<{
  value: string;
  label: string;
  origins: RunOrigin[];
}> = [
  { value: "sdk", label: RUN_ORIGIN_META.sdk.label, origins: ["sdk"] },
  { value: "ui", label: RUN_ORIGIN_META.ui.label, origins: ["ui"] },
  { value: "api", label: RUN_ORIGIN_META.api.label, origins: ["api"] },
  { value: "cli", label: RUN_ORIGIN_META.cli.label, origins: ["cli"] },
  {
    value: "mcp",
    label: RUN_ORIGIN_META.mcp.label,
    origins: ["mcp", "slack", "discord"],
  },
  {
    value: "schedule",
    label: RUN_ORIGIN_META.schedule.label,
    origins: ["schedule"],
  },
  {
    value: "github",
    label: RUN_ORIGIN_META.github_check.label,
    origins: ["github_check", "github_action"],
  },
];

/** The backend `origins` argument for a set of selected chips. */
export function originsForFilters(selected: readonly string[]): RunOrigin[] {
  const out = new Set<RunOrigin>();
  for (const chip of RUN_ORIGIN_FILTERS) {
    if (selected.includes(chip.value)) {
      for (const origin of chip.origins) out.add(origin);
    }
  }
  return [...out];
}

/**
 * "····3f9a" — the last four characters of an API key id, for a run-by cell.
 *
 * The id, never the secret: `sk_…` values are what the audit sanitizer redacts,
 * and the platform stores only the key's id here for exactly that reason.
 */
export function apiKeyTail(apiKeyId: string | null | undefined): string | null {
  if (typeof apiKeyId !== "string") return null;
  const trimmed = apiKeyId.trim();
  if (trimmed.length === 0) return null;
  return `····${trimmed.slice(-4)}`;
}

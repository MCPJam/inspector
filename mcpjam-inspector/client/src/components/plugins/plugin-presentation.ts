/**
 * Pure presentation helpers shared by the Connect plugin surfaces (PR INS-2).
 *
 * Kept separate from the components so the wording rules that MATTER can be
 * unit-tested directly:
 *
 *  - an unsupported component is never described as something MCPJam runs;
 *  - a component's health is derived from the backend's `readiness` enum, not
 *    guessed from local state; and
 *  - a plugin's rolled-up health never reports "ready" while any component is
 *    not, and never reports anything at all before a version is finalized.
 */

import type {
  PluginComponentReadiness,
  PluginSetupStatus,
  PluginSummary,
} from "@/lib/plugins/plugin-api-types";

// ---------------------------------------------------------------------------
// Component readiness.
// ---------------------------------------------------------------------------

export interface PluginReadinessPresentation {
  label: string;
  /** One-line explanation of what the user has to do, if anything. */
  detail: string;
  tone: "ready" | "attention" | "info";
}

/**
 * Backend `PluginComponentReadiness` → user-facing wording.
 *
 * `local_runtime_required` / `computer_required` are placement facts, not
 * failures: the component is fine, this client just cannot be the one to run
 * it. They read as informational rather than as errors.
 */
export function describePluginReadiness(
  readiness: PluginComponentReadiness,
): PluginReadinessPresentation {
  switch (readiness) {
    case "ready":
      return {
        label: "Ready",
        detail: "No setup required before use.",
        tone: "ready",
      };
    case "needs_auth":
      return {
        label: "Needs auth",
        detail: "Authorize this server before its first tool call.",
        tone: "attention",
      };
    case "local_runtime_required":
      return {
        label: "Local runtime",
        detail: "Runs only from a local MCPJam process.",
        tone: "info",
      };
    case "computer_required":
      return {
        label: "Computer required",
        detail: "Runs only inside a Project Computer.",
        tone: "info",
      };
    default:
      // A readiness value this client does not know yet. Report the raw code
      // rather than inventing a friendly label that might claim readiness.
      return {
        label: String(readiness),
        detail: "Unrecognized component state.",
        tone: "attention",
      };
  }
}

export function describePluginPlacement(
  placement: "remote" | "local" | "computer",
): string {
  switch (placement) {
    case "remote":
      return "Remote";
    case "local":
      return "Local";
    case "computer":
      return "Computer";
  }
}

// ---------------------------------------------------------------------------
// Plugin-level health rollup.
// ---------------------------------------------------------------------------

export type PluginHealth =
  | { kind: "disabled" }
  /** Installed, but no revision has been made active yet. */
  | { kind: "not_activated" }
  /** Setup status has not loaded (or the version is still staging). */
  | { kind: "unknown" }
  | { kind: "ready"; componentCount: number }
  | { kind: "needs_attention"; readiness: PluginComponentReadiness };

/**
 * Roll a plugin's server components up into one status line.
 *
 * Ordering is deliberately pessimistic: `needs_auth` beats the placement
 * states, which beat `ready`. A plugin is only "Ready" when EVERY component
 * is, so the card can never imply a plugin is usable while one of its servers
 * still needs authorization.
 */
const READINESS_SEVERITY: Record<string, number> = {
  needs_auth: 3,
  computer_required: 2,
  local_runtime_required: 2,
  ready: 0,
};

export function rollUpPluginHealth(
  plugin: Pick<PluginSummary, "enabled" | "activeVersionId">,
  setupStatus: PluginSetupStatus | undefined,
): PluginHealth {
  if (!plugin.enabled) return { kind: "disabled" };
  if (!plugin.activeVersionId) return { kind: "not_activated" };
  // `undefined` is "still loading"; a staging version is not runtime-visible,
  // so neither state may be rendered as ready.
  if (setupStatus === undefined) return { kind: "unknown" };
  if (setupStatus.status !== "ready") return { kind: "unknown" };

  let worst: PluginComponentReadiness | null = null;
  let worstScore = -1;
  for (const component of setupStatus.components) {
    const score = READINESS_SEVERITY[component.readiness] ?? 4;
    if (score > worstScore) {
      worstScore = score;
      worst = component.readiness;
    }
  }
  if (worst === null || worstScore === 0) {
    return { kind: "ready", componentCount: setupStatus.components.length };
  }
  return { kind: "needs_attention", readiness: worst };
}

export function describePluginHealth(health: PluginHealth): {
  label: string;
  tone: "ready" | "attention" | "info" | "muted";
} {
  switch (health.kind) {
    case "disabled":
      return { label: "Disabled", tone: "muted" };
    case "not_activated":
      return { label: "No active revision", tone: "info" };
    case "unknown":
      return { label: "Checking…", tone: "muted" };
    case "ready":
      return { label: "Ready", tone: "ready" };
    case "needs_attention": {
      const described = describePluginReadiness(health.readiness);
      return { label: described.label, tone: described.tone };
    }
  }
}

// ---------------------------------------------------------------------------
// Unsupported components.
// ---------------------------------------------------------------------------

/**
 * The ONE sentence that describes what MCPJam does with a component it does
 * not run. Centralized so the "preserved, never executed" promise cannot drift
 * between the preview and the post-install summary — the plan forbids claiming
 * OpenAI runtime parity for components MCPJam preserves but does not execute.
 */
export const PLUGIN_UNSUPPORTED_EXPLANATION =
  "Kept in the stored bundle for fidelity. MCPJam does not run these.";

/** Human label for a parser `unsupported.kind`, defaulting to the raw kind. */
export function describeUnsupportedKind(kind: string): string {
  switch (kind) {
    case "hook":
    case "hooks":
      return "Lifecycle hooks";
    case "browser_extension":
      return "Browser extension";
    case "scheduled_task":
      return "Scheduled task template";
    case "unknown_field":
      return "Unrecognized manifest field";
    default:
      return kind;
  }
}

// ---------------------------------------------------------------------------
// Misc formatting.
// ---------------------------------------------------------------------------

/** Short, copy-friendly revision label for a version's content identity. */
export function shortBundleHash(bundleHash: string): string {
  return bundleHash.slice(0, 12);
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pluralize(count: number, singular: string, plural?: string) {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

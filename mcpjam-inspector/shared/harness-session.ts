/**
 * Transient SSE data part carrying the harness's working directory for a turn.
 *
 * A Claude Code harness runs each turn inside `/home/user/claude-code-<sessionId>`
 * on the project computer. The server knows this path during the turn; it streams
 * it to the client so the Playground Shell can open a terminal there instead of in
 * the box's home. Transient (not persisted): the client caches the latest path and
 * passes it as the terminal `cwd`.
 */
export interface HarnessSessionInfo {
  /** Absolute path of the harness session workdir on the computer. */
  workdir: string;
}

export interface HarnessSessionDataPart {
  type: "data-harness-session";
  data: HarnessSessionInfo;
}

export function isHarnessSessionDataPart(
  value: unknown,
): value is HarnessSessionDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-session") {
    return false;
  }
  const data = candidate.data;
  return (
    !!data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).workdir === "string" &&
    (data as Record<string, unknown>).workdir !== ""
  );
}

/**
 * Why a harness turn could NOT warm-resume the prior in-box session and started
 * a fresh one. Surfaced to the client so a silent reset (the user's earlier
 * context is gone) becomes a visible, explainable notice instead of the model
 * appearing to "forget" everything.
 *
 *  - `sandbox-replaced`   — the project computer was reprovisioned between turns
 *                           (new sandbox / fresh disk); the saved session is
 *                           unrecoverable.
 *  - `legacy-cold-resume` — the saved sidecar predates warm-detach (no bridge
 *                           coordinates); resume is still attempted from disk but
 *                           continuity isn't guaranteed. (Logged, not necessarily
 *                           shown — it's an attempt, not a hard reset.)
 *  - `resume-failed`      — reattaching to the saved session threw; fell back fresh.
 *
 * NEVER carries raw E2B sandbox ids — only the categorical reason.
 */
export type HarnessResetReason =
  | "sandbox-replaced"
  | "legacy-cold-resume"
  | "resume-failed";

export interface HarnessResetInfo {
  reason: HarnessResetReason;
}

export interface HarnessResetDataPart {
  type: "data-harness-reset";
  data: HarnessResetInfo;
}

const HARNESS_RESET_REASONS: ReadonlySet<string> = new Set([
  "sandbox-replaced",
  "legacy-cold-resume",
  "resume-failed",
]);

export function isHarnessResetDataPart(
  value: unknown,
): value is HarnessResetDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-reset") {
    return false;
  }
  const data = candidate.data;
  return (
    !!data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).reason === "string" &&
    HARNESS_RESET_REASONS.has((data as Record<string, unknown>).reason as string)
  );
}

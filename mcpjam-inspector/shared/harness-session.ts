/**
 * Transient SSE data part carrying the harness's working directory for a turn.
 *
 * A Claude Code harness runs each turn inside `/home/user/claude-code-<sessionId>`
 * on the project computer. The server knows this path during the turn; it streams
 * it to the client so the Playground Shell can open a terminal there instead of in
 * the box's home. Transient (not persisted): the client caches the latest path and
 * passes it as the terminal `cwd`.
 */
/**
 * Which machine the turn ran on.
 *
 *  - `personal`   — the member's own computer (the Shell rail's terminal).
 *  - `disposable` — this conversation's disposable box: a harness that signs in
 *    with the member's own account, or a compare column. The workdir is a path
 *    on THAT machine, so the Shell rail's terminal (which is the personal
 *    computer) must not be opened there.
 *
 * Absent ⇒ `personal`: a server that predates the field only ever ran there.
 */
export type HarnessMachine = "personal" | "disposable";

export interface HarnessSessionInfo {
  /** Absolute path of the harness session workdir on the computer. */
  workdir: string;
  machine?: HarnessMachine;
}

export interface HarnessSessionDataPart {
  type: "data-harness-session";
  data: HarnessSessionInfo;
}

/**
 * The transient part a harness turn streams for the Playground Shell rail.
 * `disposable` is whether the turn ran on the conversation's own box rather
 * than the member's personal computer.
 */
export function buildHarnessSessionDataPart(args: {
  workdir: string;
  disposable: boolean;
}): HarnessSessionDataPart {
  return {
    type: "data-harness-session",
    data: {
      workdir: args.workdir,
      machine: args.disposable ? "disposable" : "personal",
    },
  };
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
  if (!data || typeof data !== "object") {
    return false;
  }
  const workdir = (data as Record<string, unknown>).workdir;
  const machine = (data as Record<string, unknown>).machine;
  // The contract is an ABSOLUTE path (it becomes the terminal cwd) — reject
  // relative or whitespace-padded values instead of letting cwd drift.
  return (
    typeof workdir === "string" &&
    workdir === workdir.trim() &&
    workdir.startsWith("/") &&
    (machine === undefined ||
      machine === "personal" ||
      machine === "disposable")
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
 *  - `runtime-changed`    — the chat's saved session was built for a different
 *                           runtime (model, servers, skills, permission mode or
 *                           transport), so it can't be resumed.
 *
 * NEVER carries raw E2B sandbox ids — only the categorical reason.
 */
export type HarnessResetReason =
  | "sandbox-replaced"
  | "legacy-cold-resume"
  | "resume-failed"
  | "runtime-changed";

export interface HarnessResetInfo {
  reason: HarnessResetReason;
}

export interface HarnessResetDataPart {
  type: "data-harness-reset";
  data: HarnessResetInfo;
}

const HARNESS_RESET_REASONS: ReadonlySet<HarnessResetReason> = new Set([
  "sandbox-replaced",
  "legacy-cold-resume",
  "resume-failed",
  "runtime-changed",
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
    HARNESS_RESET_REASONS.has(
      (data as Record<string, unknown>).reason as HarnessResetReason,
    )
  );
}

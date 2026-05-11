/**
 * Transport DTO + grouping-key helpers for multi-config eval runs.
 *
 * Phase 3 of the M1 plan lets a suite run target up to 3 client configs
 * concurrently. This module defines the wire-level config shape (a small
 * DTO derived from the existing chatbox/project config — chatbox UI
 * state is NOT lifted into shared/) and the runtime grouping key used
 * by the recorder and Phase 4 regression detection.
 *
 * Why a separate key from `hostConfigId`: `HostConfigInputV2` does NOT
 * include `provider` or `toolChoice`, so two configs that differ only
 * in those fields can share a `hostConfigId`. The grouping key bakes
 * `provider` and `toolChoice` into a stable identifier per execution
 * config snapshot.
 */

export type ServerRef = string;

export type ClientConfigToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string };

export type ClientConfigDto = {
  /** Stable, client-supplied; same id across reruns of the same picked config. */
  id: string;
  /** Optional human label for column headers; not used for identity. */
  label?: string;
  model: string;
  provider: string;
  systemPrompt?: string;
  temperature?: number;
  toolChoice?: ClientConfigToolChoice;
  /** Resolvable to MCP server identities; NOT raw chatbox state. */
  serverRefs: ServerRef[];
};

/**
 * Inputs used to derive `executionConfigKey`. Decoupled from
 * `ClientConfigDto` so the runner can compute the key from whatever
 * sources it has (the request DTO or a recorded iteration).
 */
export type ExecutionConfigKeyInput = {
  hostConfigId: string | null | undefined;
  provider: string | null | undefined;
  toolChoice?: ClientConfigToolChoice | null;
};

/**
 * Canonicalize a tool-choice value into a stable string. Order and
 * key-order independence matter — different JSON serializations of the
 * same logical tool choice must hash to the same key.
 */
function canonicalizeToolChoice(
  toolChoice: ClientConfigToolChoice | null | undefined,
): string {
  if (toolChoice === undefined || toolChoice === null) return "";
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "tool") {
    return `tool:${toolChoice.toolName}`;
  }
  return "";
}

/**
 * Stable, tiny, pure-JS hash. FNV-1a 32-bit. Chosen over crypto.subtle
 * so this module stays browser- AND node-safe without async APIs.
 * Collision risk for the input space (small enums + a tool name string)
 * is acceptable for grouping purposes — when two execution configs ever
 * collide the worst case is one extra column in the regression view.
 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned and emit as 8-char hex.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compute the grouping key for an iteration's execution config.
 *
 * - Two iterations with the same `hostConfigId` + same `provider` + same
 *   `toolChoice` produce the same key.
 * - Two iterations with the same `hostConfigId` but different `provider`
 *   or `toolChoice` produce different keys (this is the core reason the
 *   key exists — `HostConfigInputV2` does not carry those fields).
 * - Missing/null inputs hash to a deterministic value too, so partially
 *   populated iterations still group consistently.
 */
export function computeExecutionConfigKey(
  input: ExecutionConfigKeyInput,
): string {
  const hostConfigId = input.hostConfigId ?? "";
  const provider = input.provider ?? "";
  const toolChoice = canonicalizeToolChoice(input.toolChoice);
  const composite = `${hostConfigId}|${provider}|${toolChoice}`;
  return fnv1a32(composite);
}

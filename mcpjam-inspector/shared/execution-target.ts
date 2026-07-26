/**
 * Shared execution-target contract (Project Environments — Phase 1.1).
 *
 * ONE serializable pointer that says WHAT a hosted chat turn executes against.
 * The wire form is deliberately tiny — an id plus a discriminant — because the
 * authoritative configuration is always re-resolved server-side (a host by
 * `hostId`, an environment by `projectEnvironments:resolveEnvironmentForRuntime`).
 * Nothing about the resolved shape may be carried in the request body.
 *
 * ## Why a union instead of another optional pointer
 *
 * chat-v2 already carried `chatboxId` and a legacy `hostId`, resolved by branch
 * precedence. Adding `environmentId` as a third optional field would mean a body
 * with two pointers silently executing against one of them — the caller believes
 * they launched an environment, the server ran a bare host. So ingress
 * NORMALIZES every legacy field into one closed internal union
 * ({@link InternalExecutionTarget}) and REJECTS ambiguous combinations instead
 * of shadowing them.
 *
 * `chatboxId` is deliberately NOT folded into the public
 * {@link HostedExecutionTarget}: it is an access-bearing transport field (the
 * redeemed share-link identity, paired with `accessVersion`), not a statement
 * about which configuration to execute. It stays where it is and simply
 * conflicts with an explicit `executionTarget`.
 */

/** What the client asks to execute against. Serializable; ids only. */
export type HostedExecutionTarget =
  | { kind: "host"; hostId: string }
  | { kind: "environment"; environmentId: string };

/**
 * Per-turn, never-persisted narrowing of what an environment resolves to.
 *
 * ABSENT and `[]` are different and must stay different: absent means "use the
 * environment's own server set", `[]` means "run this turn with no MCP servers".
 * The backend resolver enforces the same distinction, and it never widens
 * authorization (see `validateRuntimeServerOverride`).
 */
export type EnvironmentOverrides = { serverIds?: string[] };

/**
 * The closed union every hosted chat ingress normalizes to. Unlike the public
 * wire type this also covers the two shapes that were never explicit targets:
 * a chatbox-bound turn and a plain ad-hoc project chat.
 */
export type InternalExecutionTarget =
  | { kind: "host"; hostId: string }
  | {
      kind: "environment";
      environmentId: string;
      overrides?: EnvironmentOverrides;
    }
  | { kind: "chatbox"; chatboxId: string }
  | { kind: "adhoc"; projectId: string };

export type NormalizeExecutionTargetResult =
  | { ok: true; target: InternalExecutionTarget }
  | { ok: false; error: string };

/** Raw, untrusted ingress fields. Every one is optional on the wire. */
export interface ExecutionTargetIngress {
  chatboxId?: unknown;
  executionTarget?: unknown;
  environmentOverrides?: unknown;
  /** Legacy pointer kept for compatibility; normalized to `{ kind: "host" }`. */
  hostId?: unknown;
  projectId?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** Parse the public wire target. Returns an error string for a malformed one. */
function parseHostedExecutionTarget(
  value: unknown
): { ok: true; target: HostedExecutionTarget } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "executionTarget must be an object" };
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "host") {
    const hostId = nonEmptyString((value as { hostId?: unknown }).hostId);
    if (!hostId) {
      return { ok: false, error: "executionTarget.hostId is required" };
    }
    return { ok: true, target: { kind: "host", hostId } };
  }
  if (kind === "environment") {
    const environmentId = nonEmptyString(
      (value as { environmentId?: unknown }).environmentId
    );
    if (!environmentId) {
      return { ok: false, error: "executionTarget.environmentId is required" };
    }
    return { ok: true, target: { kind: "environment", environmentId } };
  }
  return {
    ok: false,
    error: "executionTarget.kind must be 'host' or 'environment'",
  };
}

/**
 * Parse the per-turn override envelope. An absent envelope and an envelope with
 * an absent `serverIds` both mean "no override"; `{ serverIds: [] }` is a real,
 * meaningful override.
 */
function parseEnvironmentOverrides(
  value: unknown
):
  | { ok: true; overrides?: EnvironmentOverrides }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "environmentOverrides must be an object" };
  }
  const serverIds = (value as { serverIds?: unknown }).serverIds;
  if (serverIds === undefined) return { ok: true };
  if (
    !Array.isArray(serverIds) ||
    serverIds.some((id) => nonEmptyString(id) === undefined)
  ) {
    return {
      ok: false,
      error: "environmentOverrides.serverIds must be an array of server ids",
    };
  }
  return { ok: true, overrides: { serverIds: serverIds as string[] } };
}

/**
 * Normalize the ingress fields to exactly one internal target.
 *
 * Precedence, in order — the FIRST two rules are rejections, never fallbacks:
 *
 *   1. `chatboxId` + `executionTarget`  → invalid combination (400).
 *      A chatbox pins its own host server-side; an explicit target alongside it
 *      would either be ignored (silently wrong) or override a published
 *      chatbox's configuration from a share-link body (a security regression).
 *   2. legacy `hostId` + `executionTarget` → invalid combination (400).
 *      Two statements about what to run. Old clients send only `hostId`, new
 *      clients send only `executionTarget`; a body with both is a bug, and
 *      picking a winner is exactly the silent shadowing this normalizer exists
 *      to prevent.
 *   3. `executionTarget`  → use it.
 *   4. `chatboxId`        → chatbox turn (unchanged legacy behavior; a chatbox
 *      has always won over a stray `hostId`).
 *   5. legacy `hostId`    → `{ kind: "host" }`.
 *   6. neither            → ad-hoc direct chat.
 *
 * `environmentOverrides` is only meaningful for an environment target; supplying
 * it with any other target is rejected rather than dropped.
 */
export function normalizeExecutionTarget(
  ingress: ExecutionTargetIngress
): NormalizeExecutionTargetResult {
  const chatboxId = nonEmptyString(ingress.chatboxId);
  const hostId = nonEmptyString(ingress.hostId);
  const projectId = nonEmptyString(ingress.projectId) ?? "";
  const hasExecutionTarget =
    ingress.executionTarget !== undefined && ingress.executionTarget !== null;

  if (hasExecutionTarget && chatboxId) {
    return {
      ok: false,
      error:
        "chatboxId and executionTarget cannot be combined — a chatbox already pins its own execution configuration.",
    };
  }
  if (hasExecutionTarget && hostId) {
    return {
      ok: false,
      error:
        "hostId and executionTarget cannot be combined — send only executionTarget.",
    };
  }

  const overrides = parseEnvironmentOverrides(ingress.environmentOverrides);
  if (!overrides.ok) return { ok: false, error: overrides.error };

  if (hasExecutionTarget) {
    const parsed = parseHostedExecutionTarget(ingress.executionTarget);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.target.kind === "environment") {
      return {
        ok: true,
        target: {
          kind: "environment",
          environmentId: parsed.target.environmentId,
          ...(overrides.overrides ? { overrides: overrides.overrides } : {}),
        },
      };
    }
    if (overrides.overrides) {
      return {
        ok: false,
        error: "environmentOverrides requires an environment executionTarget.",
      };
    }
    return { ok: true, target: parsed.target };
  }

  if (overrides.overrides) {
    return {
      ok: false,
      error: "environmentOverrides requires an environment executionTarget.",
    };
  }
  if (chatboxId) return { ok: true, target: { kind: "chatbox", chatboxId } };
  if (hostId) return { ok: true, target: { kind: "host", hostId } };
  return { ok: true, target: { kind: "adhoc", projectId } };
}

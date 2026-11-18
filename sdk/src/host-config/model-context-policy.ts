/**
 * Per-client budgets for the context a plugin App pushes with
 * `ui/update-model-context` (`mcpProfile.apps.modelContextPolicy`), and how
 * they resolve.
 *
 * One resolver shared by the inspector client and server, so an App's update
 * and the turn that carries it are judged against the same numbers.
 *
 * Browser-safe and dependency-free.
 */

import type {
  HostConfigMcpProfileV1,
  HostConfigModelContextPolicyV1,
} from "./types.js";

/** The policy's keys, in canonical (sorted) order. */
export const MODEL_CONTEXT_POLICY_KEYS = [
  "maxBlocks",
  "turnMaxBytes",
  "updateMaxBytes",
] as const satisfies readonly (keyof HostConfigModelContextPolicyV1)[];
export type ModelContextPolicyKey = (typeof MODEL_CONTEXT_POLICY_KEYS)[number];

export type ResolvedModelContextPolicy = Readonly<
  Record<ModelContextPolicyKey, number>
>;

/** What a key the client never saved resolves to: MCPJam's own budgets. */
export const MODEL_CONTEXT_POLICY_DEFAULTS: ResolvedModelContextPolicy =
  Object.freeze({
    maxBlocks: 64,
    turnMaxBytes: 1024 * 1024,
    updateMaxBytes: 256 * 1024,
  });

/**
 * The most any client may save. Storage, the inspector↔backend transport and
 * the server's memory budget are sized to hold these, so state admitted under
 * any policy is re-read against the ceilings, never the current policy.
 */
export const MODEL_CONTEXT_POLICY_CEILINGS: ResolvedModelContextPolicy =
  Object.freeze({
    maxBlocks: 1024,
    turnMaxBytes: 8 * 1024 * 1024,
    updateMaxBytes: 4 * 1024 * 1024,
  });

/** A budget the canonicalizer stores and the resolver honors. */
export function isModelContextBudget(
  key: ModelContextPolicyKey,
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MODEL_CONTEXT_POLICY_CEILINGS[key]
  );
}

export interface ModelContextPolicyHostInput {
  mcpProfile?: HostConfigMcpProfileV1 | Record<string, unknown> | null;
}

function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A client's effective budgets. A key that is missing, or malformed in data
 * that skipped canonicalization, reads as the default, never as unlimited.
 */
export function resolveModelContextPolicy(
  config: ModelContextPolicyHostInput | null | undefined
): ResolvedModelContextPolicy {
  const saved = member(
    member(config?.mcpProfile, "apps"),
    "modelContextPolicy"
  );
  const resolved = { ...MODEL_CONTEXT_POLICY_DEFAULTS };
  for (const key of MODEL_CONTEXT_POLICY_KEYS) {
    const value = member(saved, key);
    if (isModelContextBudget(key, value)) resolved[key] = value;
  }
  return Object.freeze(resolved);
}

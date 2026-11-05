/**
 * Per-client plugin App context budgets
 * (`mcpProfile.apps.modelContextPolicy`): the Apps JSON editor's reader.
 *
 * Resolution and validation live in the SDK (`resolveModelContextPolicy`,
 * the host-config canonicalizer), so the editor only decides which typed
 * values reach a save.
 */

import {
  MODEL_CONTEXT_POLICY_KEYS,
  type HostConfigModelContextPolicyV1,
} from "@mcpjam/sdk/host-config/internal";

/**
 * Soft-read a hand-edited `modelContextPolicy` block. Unknown keys and
 * non-numbers are dropped like the editor's other blocks; numbers are kept
 * as typed, so a budget over its ceiling reaches the save and is refused
 * with the canonicalizer's message instead of disappearing.
 */
export function parseModelContextPolicyDoc(
  value: unknown,
): HostConfigModelContextPolicyV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const policy: HostConfigModelContextPolicyV1 = {};
  for (const key of MODEL_CONTEXT_POLICY_KEYS) {
    const budget = (value as Record<string, unknown>)[key];
    if (typeof budget === "number") policy[key] = budget;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

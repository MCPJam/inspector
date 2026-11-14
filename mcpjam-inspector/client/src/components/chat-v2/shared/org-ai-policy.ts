/**
 * View types for the organization AI key policy ("Use your keys for all AI
 * features"), as the model pickers read it from the org model config, and
 * the one place a picker asks whether an org connection is usable.
 *
 * Whether the policy is on, and whether a connection may serve AI requests
 * under it, is read only through `@/shared/org-ai-key-policy`
 * (`orgRequiresOwnKeys`, `connectionPolicyEligibility`): the backend decides,
 * and the browser never works it out on its own.
 *
 * Kept apart from `model-helpers` on purpose: many tests mock that module
 * with an explicit export list, and this helper must stay real wherever the
 * composition (`available-models`) or the run sheet runs.
 */
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { connectionPolicyEligibility } from "@/shared/org-ai-key-policy";

/** The organization's AI key policy ("Use your keys for all AI features"). */
export type OrgAiKeyPolicyView = {
  requireOrgKeys: boolean;
  revision?: number;
};

/**
 * Readiness status of an AI feature or operation. `hosted` means the policy
 * is off (today's behavior); the rest only occur while it is on.
 */
export type OrgAiReadinessStatus =
  | "hosted"
  | "ready"
  | "unconfigured"
  | "unsupported"
  | "invalid_credentials"
  | "temporarily_unavailable";

export type OrgAiReadinessView = {
  requireOrgKeys: boolean;
  features: Array<{
    id: string;
    label: string;
    status: OrgAiReadinessStatus | (string & {});
    blockedBy: string[];
    degradedBy: string[];
  }>;
  operations: Array<{
    operation: string;
    status: OrgAiReadinessStatus | (string & {});
    code?: string;
    reason?: string;
    role?: string;
    connectionId?: string;
    checkedAt?: number;
  }>;
  /** Org connections an AI request may run on under the policy. */
  eligibleConnectionIds: string[];
};

/**
 * Whether an org connection can serve AI requests: it is enabled, it has a
 * saved key unless its provider runs without one (Ollama and custom
 * endpoints; `hasSecret` absent reads as saved, as the backend reads it),
 * and, while the organization requires its own keys, the backend calls it
 * eligible (`policyEligibility`, missing = not eligible). The key check is
 * separate from the policy verdict, which never looks at keys.
 */
export function isUsableOrgConnection(
  provider: Pick<OrgModelProvider, "providerKey" | "enabled"> &
    Partial<Pick<OrgModelProvider, "hasSecret" | "policyEligibility">>,
  requireOrgKeys: boolean,
): boolean {
  if (!provider.enabled) return false;
  const keyOptional =
    provider.providerKey === "ollama" ||
    provider.providerKey.startsWith("custom:");
  if (provider.hasSecret === false && !keyOptional) return false;
  return (
    !requireOrgKeys ||
    connectionPolicyEligibility(provider, requireOrgKeys).eligible
  );
}

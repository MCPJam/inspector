/**
 * The organization AI key policy ("Use your keys for all AI features"), as
 * the model pickers read it from the org model config.
 *
 * Kept apart from `model-helpers` on purpose: many tests mock that module
 * with an explicit export list, and these helpers must stay real wherever the
 * composition (`available-models`) runs.
 */
import type { OrgModelProvider } from "@/hooks/use-org-model-config";

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

/** Whether the organization requires its own provider keys for AI features. */
export function orgKeysRequired(
  orgConfig:
    | { aiKeyPolicy?: OrgAiKeyPolicyView; aiReadiness?: OrgAiReadinessView }
    | null
    | undefined,
): boolean {
  return (
    orgConfig?.aiKeyPolicy?.requireOrgKeys === true ||
    orgConfig?.aiReadiness?.requireOrgKeys === true
  );
}

/**
 * Providers whose org connections call the provider directly from MCPJam's
 * cloud. Ollama and custom connections qualify only when their runtime is
 * `cloud`; OpenRouter never does (a shared gateway whose upstream account
 * cannot be verified as the organization's own).
 */
const DIRECT_ORG_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "azure",
  "bedrock",
  "mistral",
  "deepseek",
  "xai",
  "moonshotai",
  "z-ai",
  "qwen",
  "minimax",
]);

/** Where an org connection runs; older backends omit it (see the type). */
export function orgConnectionRuntimeLocation(
  provider: Pick<OrgModelProvider, "providerKey" | "runtimeLocation">,
): "cloud" | "local" {
  if (
    provider.runtimeLocation === "cloud" ||
    provider.runtimeLocation === "local"
  )
    return provider.runtimeLocation;
  return provider.providerKey === "ollama" ||
    provider.providerKey.startsWith("custom:")
    ? "local"
    : "cloud";
}

/**
 * Whether an AI request may run on this org connection while the org
 * requires its own keys: the backend's `aiReadiness.eligibleConnectionIds`
 * when it lists them, otherwise the same rule computed here (an enabled,
 * direct, cloud-runtime connection).
 */
export function isOrgConnectionEligible(
  provider: OrgModelProvider,
  orgConfig?: { aiReadiness?: OrgAiReadinessView } | null,
): boolean {
  if (!provider.enabled) return false;
  const eligibleIds = orgConfig?.aiReadiness?.eligibleConnectionIds;
  if (eligibleIds && provider.id) return eligibleIds.includes(provider.id);
  if (orgConnectionRuntimeLocation(provider) === "local") return false;
  if (
    provider.providerKey === "ollama" ||
    provider.providerKey.startsWith("custom:")
  )
    return true;
  return DIRECT_ORG_PROVIDER_KEYS.has(provider.providerKey);
}

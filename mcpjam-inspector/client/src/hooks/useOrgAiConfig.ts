import { useCallback, useMemo } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

/**
 * The Convex functions behind "Use your keys for all AI features".
 *
 * Exported so the mount-site boundary can recognise a deployment that does
 * not serve the query yet by its name, and so a rename cannot drift from it.
 */
export const ORG_AI_CONFIG_QUERY =
  "aiExecutionAdmission:getOrganizationAiConfig";
export const SET_REQUIRE_ORG_KEYS_MUTATION =
  "organizations:setOrganizationRequireOrgKeys";

/**
 * Whether a feature or operation can run. `hosted` is the policy-off state:
 * MCPJam-provided models serve whatever the organization has not chosen.
 */
export type AiReadinessStatus =
  | "hosted"
  | "ready"
  | "unconfigured"
  | "unsupported"
  | "invalid_credentials"
  | "temporarily_unavailable";

export type AiOperationId =
  | "chat"
  | "eval_target"
  | "persona_driver"
  | "harness_runtime"
  | "judge"
  | "text_analysis"
  | "text_generation"
  | "typed_decision"
  | "embedding"
  | "speech_transcription"
  | "agent_chat";

export type AiFeatureGroupId =
  | "chat"
  | "evals"
  | "insights"
  | "generation"
  | "session_map"
  | "harness"
  | "transcription"
  | "ask_mcpjam";

export type AiFeatureGroupReadiness = {
  id: AiFeatureGroupId;
  label: string;
  status: AiReadinessStatus;
  /** Required operations that stop the feature from running. */
  blockedBy: AiOperationId[];
  /** Optional operations whose absence only narrows what the feature does. */
  degradedBy: AiOperationId[];
};

export type AiOperationReadiness = {
  operation: AiOperationId;
  status: AiReadinessStatus;
  code?: string;
  reason?: string;
  connectionId?: string;
  checkedAt?: number;
};

export type AiReadiness = {
  requireOrgKeys: boolean;
  features: AiFeatureGroupReadiness[];
  operations: AiOperationReadiness[];
  /** Organization provider rows that any request may use under the policy. */
  eligibleConnectionIds: string[];
};

export type OrgAiConfig = {
  organizationId: string;
  aiKeyPolicy: {
    requireOrgKeys: boolean;
    revision: number;
    updatedAt?: number;
  };
  readiness: AiReadiness;
  /**
   * Whether this organization may turn the policy on: the backend's
   * Enterprise check, never the client's idea of the plan. Every viewer gets
   * it, so a member also sees why the switch is unavailable.
   */
  canEnable: boolean;
  /** The viewer is an organization owner or admin. */
  canManage: boolean;
};

/**
 * The config this UI reads, or `null` when the deployment serves the query
 * without the fields it needs. A deployment between the policy and switch
 * halves of the rollout could do that, and reading a missing `aiKeyPolicy`
 * as "off", a missing readiness as "nothing works", or a missing `canEnable`
 * as either answer would misstate what the backend allows.
 *
 * The coverage list is `readiness` on this query (the provider list's config
 * spells it `aiReadiness`; that is a different query).
 */
function completeConfig(raw: unknown): OrgAiConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<OrgAiConfig>;
  if (
    typeof candidate.aiKeyPolicy?.requireOrgKeys !== "boolean" ||
    typeof candidate.canEnable !== "boolean" ||
    typeof candidate.canManage !== "boolean" ||
    !Array.isArray(candidate.readiness?.features) ||
    !Array.isArray(candidate.readiness?.eligibleConnectionIds)
  ) {
    return null;
  }
  const config = candidate as OrgAiConfig;
  const readiness = config.readiness;
  return Array.isArray(readiness.operations)
    ? config
    : { ...config, readiness: { ...readiness, operations: [] } };
}

/**
 * "Use your keys for all AI features" for one organization. Member-read,
 * admin-write; the backend enforces the policy on every AI request, so this
 * is the setting, not the gate.
 *
 * `unsupported` is the older-backend state. A deployment that does not serve
 * the query at all makes `useQuery` throw during render, which this hook
 * cannot catch: the mount site wraps each consumer in an `ErrorBoundary`
 * (`OrgAiConfigBoundary`) that renders nothing for that shape. What the hook
 * CAN see is a deployment that serves the query without the fields this UI
 * reads, and it reports that here so a consumer says the setting isn't
 * available rather than guessing its value.
 */
export function useOrgAiConfig(organizationId: string | null): {
  config: OrgAiConfig | null | undefined;
  isLoading: boolean;
  unsupported: boolean;
  error: string | null;
  isSaving: boolean;
  setRequireOrgKeys: (enabled: boolean) => Promise<void>;
} {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const rawConfig = useQuery(
    ORG_AI_CONFIG_QUERY as never,
    enabled ? ({ organizationId } as never) : "skip",
  ) as OrgAiConfig | null | undefined;

  const setRequireOrgKeysMutation = useMutation(
    SET_REQUIRE_ORG_KEYS_MUTATION as never,
  );

  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const parsed = useMemo(
    () => (rawConfig == null ? rawConfig : completeConfig(rawConfig)),
    [rawConfig],
  );
  const unsupported = rawConfig != null && parsed === null;
  const config = unsupported ? undefined : parsed;

  const setRequireOrgKeys = useCallback(
    async (next: boolean) => {
      if (!organizationId) return;
      await run(() =>
        setRequireOrgKeysMutation({ organizationId, enabled: next } as never),
      );
    },
    [organizationId, run, setRequireOrgKeysMutation],
  );

  return useMemo(
    () => ({
      config,
      isLoading: Boolean(organizationId) && rawConfig === undefined,
      unsupported,
      error,
      isSaving,
      setRequireOrgKeys,
    }),
    [
      organizationId,
      config,
      rawConfig,
      unsupported,
      error,
      isSaving,
      setRequireOrgKeys,
    ],
  );
}

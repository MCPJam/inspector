import { useCallback, useMemo } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
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
export const SET_AI_MODEL_ROLES_MUTATION =
  "organizations:setOrganizationAiModelRoles";
export const TEST_AI_MODEL_ROLE_ACTION =
  "organizationAiModels:testOrganizationModelRole";

/** The kinds of AI work an organization can pin to one of its own models. */
export const ORG_AI_MODEL_ROLES = [
  "fast",
  "smart",
  "embedding",
  "transcription",
] as const;
export type OrgAiModelRole = (typeof ORG_AI_MODEL_ROLES)[number];

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
  role?: OrgAiModelRole;
  connectionId?: string;
  checkedAt?: number;
};

export type AiReadiness = {
  requireOrgKeys: boolean;
  features: AiFeatureGroupReadiness[];
  operations: AiOperationReadiness[];
  /** Organization provider rows a role (or, under the policy, any request) may use. */
  eligibleConnectionIds: string[];
};

export type OrgAiModelRoleCheckOutcome =
  "ok" | "auth_failed" | "unavailable" | "refused" | "failed";

export type OrgAiModelRoleCheck = {
  role: OrgAiModelRole;
  /** `${connectionId}|${modelId}|${nativeModelId ?? ""}` — see {@link orgAiRoleSelectionKey}. */
  selectionKey: string;
  checkedAt: number;
  outcome: OrgAiModelRoleCheckOutcome;
  code?: string;
};

export type OrgAiModelRoleSelections = Partial<
  Record<OrgAiModelRole, ModelSelection>
>;

export type OrgAiModelRoles = OrgAiModelRoleSelections & {
  revision: number;
  updatedAt?: number;
};

/** Only the roles named are touched; `null` clears one. */
export type OrgAiModelRoleChanges = Partial<
  Record<OrgAiModelRole, ModelSelection | null>
>;

export type OrgAiConfig = {
  organizationId: string;
  aiKeyPolicy: {
    requireOrgKeys: boolean;
    revision: number;
    updatedAt?: number;
  };
  aiModelRoles: OrgAiModelRoles;
  aiModelRoleChecks: OrgAiModelRoleCheck[];
  readiness: AiReadiness;
  /** Present for owners and admins only. */
  suggestedAiModelRoles?: OrgAiModelRoleSelections;
  canManage: boolean;
};

export type OrgAiModelRoleSaveResult = {
  revision: number;
  changed: OrgAiModelRole[];
};

export type OrgAiModelRoleTestResult = {
  role: OrgAiModelRole;
  outcome: OrgAiModelRoleCheckOutcome;
  code?: string;
  checkedAt: number;
};

/**
 * The key a role check is recorded under, so a check is only ever shown
 * beside the exact connection + model it tested. A check for a model the role
 * no longer points at is history, not the current state.
 */
export function orgAiRoleSelectionKey(selection: ModelSelection): string {
  const connectionId =
    selection.connectionRef?.kind === "orgProvider"
      ? selection.connectionRef.id
      : "";
  return `${connectionId}|${selection.modelId}|${selection.nativeModelId ?? ""}`;
}

/**
 * Whether a config is the shape this UI reads. A deployment between the
 * policy and readiness halves of the rollout could serve the query without
 * them, and reading a missing `aiKeyPolicy` as "off" — or a missing readiness
 * as "nothing works" — would misstate what the backend enforces.
 */
function isCompleteConfig(config: OrgAiConfig): boolean {
  return (
    typeof config === "object" &&
    typeof config.aiKeyPolicy?.requireOrgKeys === "boolean" &&
    Array.isArray(config.readiness?.features) &&
    Array.isArray(config.readiness?.eligibleConnectionIds)
  );
}

/**
 * "Use your keys for all AI features" and the organization's model roles.
 * Member-read, admin-write; the backend enforces the policy on every AI
 * request, so this is the setting, not the gate.
 *
 * `unsupported` is the older-backend state. A deployment that does not serve
 * the query at all makes `useQuery` throw during render, which this hook
 * cannot catch: the mount site wraps each consumer in an `ErrorBoundary`
 * (`OrgAiConfigBoundary`) that renders nothing for that shape. What the hook
 * CAN see is a deployment that serves the query without the fields this UI
 * reads, and it reports that here so a consumer renders nothing rather than
 * guessing.
 */
export function useOrgAiConfig(organizationId: string | null): {
  config: OrgAiConfig | null | undefined;
  isLoading: boolean;
  unsupported: boolean;
  error: string | null;
  isSaving: boolean;
  /** A role test's own failure, kept apart from save errors. */
  testError: string | null;
  isTesting: boolean;
  setRequireOrgKeys: (enabled: boolean) => Promise<void>;
  saveRoles: (
    changes: OrgAiModelRoleChanges,
  ) => Promise<OrgAiModelRoleSaveResult | undefined>;
  testRole: (
    role: OrgAiModelRole,
    selection?: ModelSelection,
  ) => Promise<OrgAiModelRoleTestResult | undefined>;
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
  const setRolesMutation = useMutation(SET_AI_MODEL_ROLES_MUTATION as never);
  const testRoleAction = useAction(TEST_AI_MODEL_ROLE_ACTION as never);

  const { error, isSaving, run } = useOrgScopedWrite(organizationId);
  const {
    error: testError,
    isSaving: isTesting,
    run: runTest,
  } = useOrgScopedWrite(organizationId);

  const unsupported = rawConfig != null && !isCompleteConfig(rawConfig);
  const config = unsupported ? undefined : rawConfig;

  const setRequireOrgKeys = useCallback(
    async (next: boolean) => {
      if (!organizationId) return;
      await run(() =>
        setRequireOrgKeysMutation({ organizationId, enabled: next } as never),
      );
    },
    [organizationId, run, setRequireOrgKeysMutation],
  );

  const saveRoles = useCallback(
    async (changes: OrgAiModelRoleChanges) => {
      if (!organizationId) return undefined;
      let result: OrgAiModelRoleSaveResult | undefined;
      await run(async () => {
        result = (await setRolesMutation({
          organizationId,
          roles: changes,
        } as never)) as OrgAiModelRoleSaveResult;
      });
      return result;
    },
    [organizationId, run, setRolesMutation],
  );

  const testRole = useCallback(
    async (role: OrgAiModelRole, selection?: ModelSelection) => {
      if (!organizationId) return undefined;
      let result: OrgAiModelRoleTestResult | undefined;
      await runTest(async () => {
        result = (await testRoleAction({
          organizationId,
          role,
          ...(selection ? { selection } : {}),
        } as never)) as OrgAiModelRoleTestResult;
      });
      return result;
    },
    [organizationId, runTest, testRoleAction],
  );

  return useMemo(
    () => ({
      config,
      isLoading: Boolean(organizationId) && rawConfig === undefined,
      unsupported,
      error,
      isSaving,
      testError,
      isTesting,
      setRequireOrgKeys,
      saveRoles,
      testRole,
    }),
    [
      organizationId,
      config,
      rawConfig,
      unsupported,
      error,
      isSaving,
      testError,
      isTesting,
      setRequireOrgKeys,
      saveRoles,
      testRole,
    ],
  );
}

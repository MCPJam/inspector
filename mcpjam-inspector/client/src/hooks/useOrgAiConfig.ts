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
export const SET_ORG_AI_MODEL_MUTATION =
  "organizationAiModels:setOrganizationAiModel";
/** An action: a test makes a real, tiny call on the organization's provider. */
export const TEST_ORG_AI_MODEL_ACTION =
  "organizationAiModels:testOrganizationAiModel";

/**
 * The organization's own AI models for background work, one per kind:
 * `default` for text work nobody picks a model for (analysis, generation,
 * typed decisions, the simulated user), and later `embedding` and
 * `transcription`. An admin chooses each one; MCPJam only suggests. Model
 * pickers never use them, and the judge is always an explicit pick.
 *
 * The backend says which kinds it supports (`supportedModelKinds`), and the
 * settings card shows one row per supported kind, so a kind this list knows
 * but the backend does not serve yet never shows.
 */
export const ORG_AI_MODEL_KINDS = [
  "default",
  "embedding",
  "transcription",
] as const;
export type OrgAiModelKind = (typeof ORG_AI_MODEL_KINDS)[number];

const ORG_AI_MODEL_KIND_SET: ReadonlySet<string> = new Set(ORG_AI_MODEL_KINDS);

export function isOrgAiModelKind(value: unknown): value is OrgAiModelKind {
  return typeof value === "string" && ORG_AI_MODEL_KIND_SET.has(value);
}

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
  /**
   * The organization AI model this operation runs on, when nobody picks one
   * for it (background work on the `default` model). Absent for picked
   * models and on older backends.
   */
  modelKind?: OrgAiModelKind;
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

/** The last test of a saved model, recorded by the backend. */
export type OrgAiModelCheck = {
  ok: boolean;
  /** Why it failed: a refusal code, `http_<status>`, `timeout`, or absent. */
  code?: string;
  checkedAt: number;
};

/** Why a saved model can't run now (its connection was removed, …). */
export type OrgAiModelProblem = { code: string; message: string };

/** One kind's saved model, as the config reports it. */
export type OrgAiModelEntry = {
  selection: ModelSelection;
  /** The model's name, without the connection's. */
  label: string;
  /** The last test of exactly this selection, or `null` when never tested. */
  check: OrgAiModelCheck | null;
  problem: OrgAiModelProblem | null;
};

/** What a test returns; it is also recorded when it tests the saved model. */
export type OrgAiModelTestResult = OrgAiModelCheck & { selectionKey?: string };

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
  /**
   * The kinds of organization AI model this backend supports, in display
   * order. Absent on a backend that has no organization AI models yet.
   */
  supportedModelKinds?: string[];
  /** One entry per supported kind; `null` when that kind is not set. */
  aiModels?: Partial<Record<OrgAiModelKind, OrgAiModelEntry | null>>;
  /** Owners and admins only. Shown as suggestions; never applied by itself. */
  aiModelSuggestions?: Partial<Record<OrgAiModelKind, ModelSelection>>;
};

/**
 * The key a check is recorded under (`connection|modelId|nativeModelId`), so
 * a candidate's test result is only shown beside the exact connection and
 * model it tested.
 */
export function orgAiModelSelectionKey(selection: ModelSelection): string {
  const connectionId =
    selection.connectionRef?.kind === "orgProvider"
      ? selection.connectionRef.id
      : "";
  return `${connectionId}|${selection.modelId}|${selection.nativeModelId ?? ""}`;
}

/**
 * The organization AI models a config reports, or `null` on a backend that
 * does not report them (no `supportedModelKinds` or no `aiModels`): the
 * settings card then shows nothing rather than an empty choice nobody can
 * save. Kinds this client does not know are left out.
 */
export function orgAiModelsOf(config: OrgAiConfig | null | undefined): {
  kinds: OrgAiModelKind[];
  models: Partial<Record<OrgAiModelKind, OrgAiModelEntry | null>>;
  suggestions: Partial<Record<OrgAiModelKind, ModelSelection>>;
} | null {
  if (!config) return null;
  const { supportedModelKinds, aiModels } = config;
  if (
    !Array.isArray(supportedModelKinds) ||
    typeof aiModels !== "object" ||
    aiModels === null
  ) {
    return null;
  }
  const kinds = [...new Set(supportedModelKinds.filter(isOrgAiModelKind))];
  if (kinds.length === 0) return null;
  return {
    kinds,
    models: aiModels,
    suggestions: config.aiModelSuggestions ?? {},
  };
}

/**
 * The config this UI reads, or `null` when the deployment serves the query
 * without the fields it needs. An incomplete answer is never read as a
 * setting: a missing `aiKeyPolicy` as "off", a missing readiness as "nothing
 * works", or a missing `canEnable` as either answer would misstate what the
 * backend allows.
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
 * "Use your keys for all AI features" and the organization's AI models for
 * background work, for one organization. Member-read, admin-write; the
 * backend enforces the policy on every AI request, so this is the setting,
 * not the gate.
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
  /** A model test's own failure, kept apart from save errors. */
  testError: string | null;
  isTesting: boolean;
  setRequireOrgKeys: (enabled: boolean) => Promise<void>;
  /** Sets one kind's model; `null` clears it. */
  setAiModel: (
    kind: OrgAiModelKind,
    selection: ModelSelection | null,
  ) => Promise<void>;
  /** Tests the saved model for `kind`, or `selection` before it is saved. */
  testAiModel: (
    kind: OrgAiModelKind,
    selection?: ModelSelection,
  ) => Promise<OrgAiModelTestResult | undefined>;
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
  const setAiModelMutation = useMutation(SET_ORG_AI_MODEL_MUTATION as never);
  const testAiModelAction = useAction(TEST_ORG_AI_MODEL_ACTION as never);

  const { error, isSaving, run } = useOrgScopedWrite(organizationId);
  const {
    error: testError,
    isSaving: isTesting,
    run: runTest,
  } = useOrgScopedWrite(organizationId);

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

  const setAiModel = useCallback(
    async (kind: OrgAiModelKind, selection: ModelSelection | null) => {
      if (!organizationId) return;
      await run(() =>
        setAiModelMutation({ organizationId, kind, selection } as never),
      );
    },
    [organizationId, run, setAiModelMutation],
  );

  const testAiModel = useCallback(
    async (kind: OrgAiModelKind, selection?: ModelSelection) => {
      if (!organizationId) return undefined;
      let result: OrgAiModelTestResult | undefined;
      await runTest(async () => {
        result = (await testAiModelAction({
          organizationId,
          kind,
          ...(selection ? { selection } : {}),
        } as never)) as OrgAiModelTestResult;
      });
      return result;
    },
    [organizationId, runTest, testAiModelAction],
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
      setAiModel,
      testAiModel,
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
      setAiModel,
      testAiModel,
    ],
  );
}

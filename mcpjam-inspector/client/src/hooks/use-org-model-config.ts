import { useOrgUsagePages } from "./org-usage-pages";
import { useCallback, useState } from "react";
import { useQuery, useAction } from "convex/react";
import {
  orgRequiresOwnKeys,
  type PolicyEligibility,
} from "@/shared/org-ai-key-policy";
import type {
  GatewayApi,
  GatewayLastTest,
  GatewayModel,
} from "@/shared/gateway-connection";

export interface OrgModelProvider {
  /**
   * The `organizationModelProviders` row id, when the visible config exposes
   * it. A saved `source: "org"` model selection references the connection by
   * this id; without it the picker keeps the legacy model id.
   */
  id?: string;
  providerKey: string;
  enabled: boolean;
  baseUrl?: string;
  protocol?: string;
  modelIds?: string[];
  displayName?: string;
  selectedModels?: string[];
  hasSecret: boolean;
  /**
   * Where the connection runs (`cloud`: MCPJam calls the provider; `local`:
   * an Inspector does), as the backend reports it. Display only: whether the
   * connection may serve AI requests is `policyEligibility`.
   */
  runtimeLocation?: "cloud" | "local";
  /**
   * The backend's verdict on whether AI requests may run on this connection
   * while the organization requires its own keys. Read it only through
   * `connectionPolicyEligibility` (`@/shared/org-ai-key-policy`), which fails
   * closed when an older backend sent none.
   */
  policyEligibility?: PolicyEligibility;
  /**
   * A gateway connection's APIs, models and last Test. Read only for
   * `custom:*` rows: built-in rows carry values filled in for compatibility.
   * Absent from older backends.
   */
  apis?: GatewayApi[];
  models?: GatewayModel[];
  lastTest?: GatewayLastTest;
}

export type UpsertOrgProviderArgs = {
  providerKey: string;
  secret?: string;
  baseUrl?: string;
  protocol?: string;
  modelIds?: string[];
  displayName?: string;
  selectedModels?: string[];
  /** The gateway editor always sends where calls come from. */
  runtimeLocation?: "cloud" | "local";
  apis?: GatewayApi[];
  models?: GatewayModel[];
};

export interface OrgModelConfigResult {
  providers: OrgModelProvider[] | undefined;
  /** The organization requires its own keys for AI features. */
  requireOrgKeys: boolean;
  isLoading: boolean;
  upsertProvider: (args: UpsertOrgProviderArgs) => Promise<{ success: true }>;
  deleteProvider: (providerKey: string) => Promise<{ success: true }>;
  isSaving: boolean;
  error: string | null;
}

export interface OrgModelUsageAggregate {
  key: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Absent from a backend that predates usage-by-effort. */
  reasoningTokens?: number;
  knownCostUsd: number;
  knownCostRequests: number;
  unknownCostRequests: number;
}

/** One model × effective reasoning effort row of the usage summary. */
export interface OrgModelEffortUsageAggregate extends OrgModelUsageAggregate {
  modelId: string;
  /** The effort that ran; `"default"` when the call sent no effort. */
  reasoningEffort: string;
}

export interface OrgModelUsageSummary {
  startAt: number;
  endAt: number;
  rangeDays: number;
  total: OrgModelUsageAggregate;
  byDate: OrgModelUsageAggregate[];
  byProvider: OrgModelUsageAggregate[];
  byModel: OrgModelUsageAggregate[];
  /** Absent from a backend that predates usage-by-effort; fall back to `byModel`. */
  byModelEffort?: OrgModelEffortUsageAggregate[];
  byProject: OrgModelUsageAggregate[];
  byUser: OrgModelUsageAggregate[];
  recentRecords: Array<{
    id: string;
    createdAt: number;
    providerKey?: string;
    modelId: string;
    projectId?: string;
    userId?: string;
    guestExternalId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningEffort?: string;
    reasoningTokens?: number;
    costStatus?: "not_reported" | "provider_reported" | "estimated";
    costUsd?: number;
    requestId?: string;
    providerResponseId?: string;
  }>;
}

export function useOrgModelUsageSummary(
  organizationId: string | null,
  options: { enabled?: boolean; rangeDays?: number } = {}
): { summary: OrgModelUsageSummary | undefined; isLoading: boolean } {
  return useOrgUsagePages(organizationId, options.enabled ?? true, options.rangeDays ?? 30);
}

export function useOrgModelConfig(
  organizationId: string | null
): OrgModelConfigResult {
  const shouldQuery = !!organizationId;

  const config = useQuery(
    "organizationModelProviders:getVisibleConfig" as any,
    shouldQuery ? ({ organizationId } as any) : "skip"
  ) as { providers: OrgModelProvider[]; aiKeyPolicy?: unknown } | undefined;

  const upsertProviderAction = useAction(
    "organizationModelProviders:upsertProvider" as any
  );
  const deleteProviderAction = useAction(
    "organizationModelProviders:deleteProvider" as any
  );

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upsertProvider = useCallback(
    async (args: UpsertOrgProviderArgs): Promise<{ success: true }> => {
      if (!organizationId) throw new Error("Organization is required");
      setIsSaving(true);
      setError(null);
      try {
        const result = await upsertProviderAction({
          organizationId,
          ...args,
        });
        return result as { success: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save provider";
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [organizationId, upsertProviderAction]
  );

  const deleteProvider = useCallback(
    async (providerKey: string): Promise<{ success: true }> => {
      if (!organizationId) throw new Error("Organization is required");
      setIsSaving(true);
      setError(null);
      try {
        const result = await deleteProviderAction({
          organizationId,
          providerKey,
        });
        return result as { success: true };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete provider";
        setError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [organizationId, deleteProviderAction]
  );

  return {
    providers: config?.providers,
    requireOrgKeys: orgRequiresOwnKeys(config),
    isLoading: shouldQuery && config === undefined,
    upsertProvider,
    deleteProvider,
    isSaving,
    error,
  };
}

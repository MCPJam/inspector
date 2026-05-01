import { useCallback, useState } from "react";
import { useQuery, useAction } from "convex/react";

export interface OrgModelProvider {
  providerKey: string;
  enabled: boolean;
  baseUrl?: string;
  protocol?: string;
  modelIds?: string[];
  displayName?: string;
  selectedModels?: string[];
  hasSecret: boolean;
}

export interface OrgModelConfigResult {
  providers: OrgModelProvider[] | undefined;
  isLoading: boolean;
  upsertProvider: (args: {
    providerKey: string;
    secret?: string;
    baseUrl?: string;
    protocol?: string;
    modelIds?: string[];
    displayName?: string;
    selectedModels?: string[];
  }) => Promise<{ success: true }>;
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
  knownCostUsd: number;
  knownCostRequests: number;
  unknownCostRequests: number;
}

export interface OrgModelUsageSummary {
  startAt: number;
  endAt: number;
  rangeDays: number;
  total: OrgModelUsageAggregate;
  byDate: OrgModelUsageAggregate[];
  byProvider: OrgModelUsageAggregate[];
  byModel: OrgModelUsageAggregate[];
  byWorkspace: OrgModelUsageAggregate[];
  byUser: OrgModelUsageAggregate[];
  recentRecords: Array<{
    id: string;
    createdAt: number;
    providerKey?: string;
    modelId: string;
    workspaceId?: string;
    userId?: string;
    guestExternalId?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
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
  const enabled = options.enabled ?? true;
  const shouldQuery = !!organizationId && enabled;

  const summary = useQuery(
    "organizationModelProviders:getUsageSummary" as any,
    shouldQuery
      ? ({
          organizationId,
          rangeDays: options.rangeDays ?? 30,
        } as any)
      : "skip"
  ) as OrgModelUsageSummary | undefined;

  return {
    summary,
    isLoading: shouldQuery && summary === undefined,
  };
}

export function useOrgModelConfig(
  organizationId: string | null
): OrgModelConfigResult {
  const shouldQuery = !!organizationId;

  const config = useQuery(
    "organizationModelProviders:getVisibleConfig" as any,
    shouldQuery ? ({ organizationId } as any) : "skip"
  ) as { providers: OrgModelProvider[] } | undefined;

  const upsertProviderAction = useAction(
    "organizationModelProviders:upsertProvider" as any
  );
  const deleteProviderAction = useAction(
    "organizationModelProviders:deleteProvider" as any
  );

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upsertProvider = useCallback(
    async (args: {
      providerKey: string;
      secret?: string;
      baseUrl?: string;
      protocol?: string;
      modelIds?: string[];
      displayName?: string;
      selectedModels?: string[];
    }): Promise<{ success: true }> => {
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
    isLoading: shouldQuery && config === undefined,
    upsertProvider,
    deleteProvider,
    isSaving,
    error,
  };
}

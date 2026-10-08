import { useCallback, useEffect, useMemo, useState } from "react";
import {
  selectionKey,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import {
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import { modelSelectionFromDefinition } from "@/components/chat-v2/shared/model-selection";
import { useHostedModelCatalog } from "@/hooks/use-hosted-model-catalog";
import {
  loadSelectedModelSelections,
  migrateSelectedModelsToV2,
  normalizeSelectedModelSelections,
  saveSelectedModelSelections,
  subscribeSelectedModelSelections,
} from "@/lib/selected-model-storage";

export interface UseCompareSelectionsReturn {
  /**
   * The compare line-up (storage v2), or `null` while the one-time migration
   * from the v1 id list has not run — the caller then keeps its v1 behaviour.
   */
  selections: RequestedModelSelection[] | null;
  setSelections: (selections: readonly RequestedModelSelection[]) => void;
}

/**
 * The compare line-up as saved selections, with the one-time v1 → v2
 * migration. React state is authoritative for in-app writes (persisted
 * event-free, like the v1 array); the migration and other tabs notify.
 *
 * `ready` gates the migration: pass false until the surface's model list is
 * settled (the persisted lead resolved) and on surfaces that pin a model.
 */
export function useCompareSelections({
  availableModels,
  orgConfig,
  ready,
  v1ModelIds,
}: {
  availableModels: readonly ModelDefinition[];
  orgConfig: OrgVisibleConfig | undefined;
  ready: boolean;
  /** The surface's v1 id list (`selectedModelIds`), migrated when non-empty. */
  v1ModelIds?: readonly string[];
}): UseCompareSelectionsReturn {
  const { hostedCatalog, status } = useHostedModelCatalog();
  const [selections, setSelectionsState] = useState<
    RequestedModelSelection[] | null
  >(() =>
    typeof window === "undefined" ? null : loadSelectedModelSelections(),
  );

  useEffect(
    () =>
      subscribeSelectedModelSelections(() => {
        setSelectionsState(loadSelectedModelSelections());
      }),
    [],
  );

  const hostedCatalogModelIds = useMemo(
    () =>
      new Set(
        status === "live" ? hostedCatalog.map((model) => String(model.id)) : [],
      ),
    [hostedCatalog, status],
  );

  useEffect(() => {
    if (selections !== null || !ready) return;
    const ownRows = (modelId: string, provider: string) =>
      availableModels.filter(
        (model) =>
          String(model.id) === modelId &&
          String(model.provider) === provider &&
          !isMCPJamProvidedModelMenuItem(model),
      );
    const migrated = migrateSelectedModelsToV2({
      v1ModelIds,
      catalogStatus: status,
      hostedCatalogModelIds,
      ownKeySelectionsFor: (modelId, provider) => {
        const byConnection = new Map<string, RequestedModelSelection>();
        for (const row of ownRows(modelId, provider)) {
          const selection = modelSelectionFromDefinition(
            row,
            orgConfig,
            "chat",
          );
          if (selection) byConnection.set(selectionKey(selection), selection);
        }
        return [...byConnection.values()];
      },
      isProviderRowListed: (modelId, provider) =>
        availableModels.some(
          (model) =>
            String(model.id) === modelId && String(model.provider) === provider,
        ),
    });
    if (migrated) setSelectionsState(migrated);
  }, [
    availableModels,
    hostedCatalogModelIds,
    orgConfig,
    ready,
    selections,
    status,
    v1ModelIds,
  ]);

  const setSelections = useCallback(
    (next: readonly RequestedModelSelection[]) => {
      const normalized = normalizeSelectedModelSelections(next);
      saveSelectedModelSelections(normalized);
      setSelectionsState(normalized);
    },
    [],
  );

  return { selections, setSelections };
}

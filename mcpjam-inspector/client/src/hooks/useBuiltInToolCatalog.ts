import { useQuery } from "convex/react";

/**
 * One catalog entry describing a host-managed built-in tool. Mirrors the
 * backend `BuiltInToolCatalogEntry` DTO from
 * `mcpjam-backend/convex/builtInTools/catalog.ts` (enabled rows only).
 */
export type BuiltInToolCatalogEntry = {
  /** Stable wire id == the AI SDK tool name the model invokes. */
  id: string;
  displayLabel: string;
  description: string;
  category: string;
  billable: boolean;
};

/**
 * Subscribe to the enabled built-in tool catalog. Returns `undefined` while
 * loading (and on deployments where the backend function isn't deployed yet),
 * then the live list via Convex's normal subscription.
 *
 * The inspector references Convex functions by string id — it does not import
 * the backend's generated `api`. This resolves once mcpjam-backend deploys
 * `builtInTools/catalog:listBuiltInTools`; until then the query stays
 * `undefined` and the editor hides its built-in tools section.
 */
export function useBuiltInToolCatalog(): BuiltInToolCatalogEntry[] | undefined {
  return useQuery(
    "builtInTools/catalog:listBuiltInTools" as never,
    {} as never,
  ) as BuiltInToolCatalogEntry[] | undefined;
}

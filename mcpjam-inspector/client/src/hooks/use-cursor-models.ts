import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "./use-is-member-actor";
import { cursorModelRows, type CursorModelCatalog } from "@/lib/cursor-models";

const query = makeFunctionReference<
  "query",
  {
    projectId: string;
    harnessId: "cursor";
  },
  CursorModelCatalog
>("organizationHarnessModels:listForProject");

export function useCursorModels(
  projectId: string | null | undefined,
  enabled: boolean,
  savedModelIds: readonly string[] = [],
) {
  const { isAuthenticated } = useConvexAuth();
  const ready = useDbUserReady();
  const member = useIsMemberActor();
  const active =
    enabled && isAuthenticated && ready && member === true && !!projectId;
  const catalog = useQuery(
    query,
    active ? { projectId, harnessId: "cursor" } : "skip",
  );
  const savedKey = savedModelIds.join("\u0001");
  return useMemo(
    () => ({
      models: enabled ? cursorModelRows(catalog, savedKey.split("\u0001")) : [],
      pending: enabled && catalog === undefined,
    }),
    [enabled, catalog, savedKey],
  );
}

/**
 * The tools a case's steps and assertions can name: the suite servers' tools
 * from the shared eval tool-metadata store (the cache the old editor fills),
 * plus the suite harness's built-in tools.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "sonner";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "@/lib/mcpjam-agent/eval-tool-metadata";
import { listEvalTools } from "@/lib/apis/evals-api";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { useHarnessBuiltinToolCatalog } from "@/hooks/useHarnessBuiltinTools";
import { mergeSystemToolsIntoAvailableTools } from "@/components/evals/harness-system-tools";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import type { EvalSuite } from "@/components/evals/types";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { ToolCatalogStatus } from "../case-scorecard/route-row";

const getSuiteConfigRef = makeFunctionReference<
  "query",
  { suiteId: string },
  HostConfigDtoV2 | null
>("hostConfigsV2:getSuiteConfig");

export function useCaseTools({
  suite,
  projectId,
  canQuery,
}: {
  suite: EvalSuite | null | undefined;
  projectId: string | null;
  canQuery: boolean;
}): {
  suiteServers: string[];
  availableTools: AvailableTool[];
  toolsStatus?: ToolCatalogStatus;
  retryTools: () => void;
} {
  const suiteId = suite?._id ?? null;
  const suiteServers = useMemo(
    () => (suite ? getEffectiveSuiteServers(suite) : []),
    [suite],
  );
  const serverIdsKey = JSON.stringify([...suiteServers].sort());
  const target = useMemo(
    () => ({
      projectId: projectId ?? "",
      environmentKey: JSON.stringify([
        suiteId,
        suite?.environment,
        serverIdsKey,
      ]),
      serverIds: JSON.parse(serverIdsKey) as string[],
    }),
    [projectId, suiteId, suite?.environment, serverIdsKey],
  );
  const entries = useEvalToolMetadata((state) => state.entries);
  // `entries` is the store's change signal; the read itself goes through
  // `target`, so it is named here to make it a real dependency.
  const snapshot = useMemo(() => {
    void entries;
    return readEvalToolMetadata(target);
  }, [target, entries]);
  const load = useCallback(
    (serverId: string) => listEvalTools({ projectId, serverIds: [serverId] }),
    [projectId],
  );
  useEffect(() => {
    if (!suiteId) return;
    void loadEvalToolMetadata(target, load);
  }, [suiteId, target, load]);

  const hostConfig = useQuery(
    getSuiteConfigRef,
    canQuery && suiteId ? { suiteId } : "skip",
  );
  const { tools: harnessTools } = useHarnessBuiltinToolCatalog(
    hostConfig?.harness ?? null,
  );
  const availableTools = useMemo(
    () => mergeSystemToolsIntoAvailableTools(snapshot.tools, harnessTools),
    [snapshot.tools, harnessTools],
  );
  const missing = (status: "loading" | "error") =>
    snapshot.servers.some(
      (server) => server.status === status && server.tools.length === 0,
    );
  const toolsStatus: ToolCatalogStatus | undefined = missing("loading")
    ? "loading"
    : missing("error")
      ? "error"
      : undefined;
  const retryTools = useCallback(() => {
    loadEvalToolMetadata(target, load, true).catch((error: unknown) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't reload tools. Check the server connection and try again.",
      ),
    );
  }, [target, load]);

  return { suiteServers, availableTools, toolsStatus, retryTools };
}

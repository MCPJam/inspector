/**
 * The suite's tools, for the field editors' pickers. Reads the same shared
 * tool-metadata store today's editor fills, so both editors share one fetch.
 */
import { useEffect, useMemo } from "react";
import { listEvalTools } from "@/lib/apis/evals-api";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "@/lib/mcpjam-agent/eval-tool-metadata";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { EvalSuite } from "@/components/evals/types";

export function useCaseTools(
  projectId: string | null,
  suite: EvalSuite | undefined,
): AvailableTool[] {
  const serverIdsKey = JSON.stringify(
    suite ? [...getEffectiveSuiteServers(suite)].sort() : [],
  );
  const target = useMemo(
    () => ({
      projectId: projectId ?? "",
      environmentKey: JSON.stringify([
        suite?._id,
        suite?.environment,
        serverIdsKey,
      ]),
      serverIds: JSON.parse(serverIdsKey) as string[],
    }),
    [projectId, suite?._id, suite?.environment, serverIdsKey],
  );
  const entries = useEvalToolMetadata((state) => state.entries);
  useEffect(() => {
    if (!suite || !projectId) return;
    void loadEvalToolMetadata(target, (serverId) =>
      listEvalTools({ projectId, serverIds: [serverId] }),
    );
  }, [Boolean(suite), projectId, target]);
  return useMemo(() => readEvalToolMetadata(target).tools, [target, entries]);
}

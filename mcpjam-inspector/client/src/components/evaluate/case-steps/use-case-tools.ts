/**
 * The tools a case can assert on: the suite's servers' tools, read through
 * the same cached store the old editor fills, so both editors share one fetch.
 */

import { useEffect, useMemo } from "react";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "@/lib/mcpjam-agent/eval-tool-metadata";
import { listEvalTools } from "@/lib/apis/evals-api";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import type { EvalSuite } from "@/components/evals/types";
import type { AvailableTool } from "@/components/evals/step-fields";
import type { ToolCatalogStatus } from "../case-scorecard/route-row";

export function useCaseTools(
  suite: EvalSuite,
  projectId: string | null | undefined,
): { tools: AvailableTool[]; status: ToolCatalogStatus | undefined } {
  const serverIds = useMemo(
    () => [...getEffectiveSuiteServers(suite)].sort(),
    [suite],
  );
  const serverKey = JSON.stringify(serverIds);
  const target = useMemo(
    () => ({
      projectId: projectId ?? "",
      // The key the old editor uses, so a catalogue it loaded is reused.
      environmentKey: JSON.stringify([suite._id, suite.environment, serverKey]),
      serverIds: JSON.parse(serverKey) as string[],
    }),
    [projectId, suite._id, suite.environment, serverKey],
  );
  useEffect(() => {
    void loadEvalToolMetadata(target, (serverId) =>
      listEvalTools({ projectId, serverIds: [serverId] }),
    );
  }, [target, projectId]);
  const entries = useEvalToolMetadata((state) => state.entries);
  return useMemo(() => {
    const snapshot = readEvalToolMetadata(target);
    const missing = (status: "loading" | "error") =>
      snapshot.servers.some(
        (server) => server.status === status && server.tools.length === 0,
      );
    return {
      tools: snapshot.tools,
      status: missing("loading")
        ? "loading"
        : missing("error")
          ? "error"
          : undefined,
    };
    // `entries` is the store's change signal; the snapshot reads it.
  }, [target, entries]);
}

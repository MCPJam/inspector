import { conformanceBudgetFields, type ConformanceRunBudget } from "./mcp-conformance-api";
import type {
  ConformanceConnectionResult,
  ConformanceProtocolSelection,
} from "@/shared/conformance-connection";
import { runByMode } from "./mode-client";
import { localPost } from "./local-post";
import { webPost } from "./web/base";
import { buildServerRequest } from "./web/context";

export function checkConformanceConnection(
  serverName: string,
  protocolVersion: ConformanceProtocolSelection,
  budget?: ConformanceRunBudget,
): Promise<ConformanceConnectionResult> {
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/connection-check", {
        serverId: serverName,
        protocolVersion,
        ...conformanceBudgetFields(budget),
      }, ...(budget?.signal ? [{ signal: budget.signal }] : [])),
    hosted: () =>
      webPost("/api/web/conformance/connection-check", {
        ...buildServerRequest(serverName),
        protocolVersion,
        ...conformanceBudgetFields(budget),
      }, ...(budget?.signal ? [{ signal: budget.signal }] : [])),
  });
}

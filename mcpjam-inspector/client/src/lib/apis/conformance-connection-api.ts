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
): Promise<ConformanceConnectionResult> {
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/connection-check", {
        serverId: serverName,
        protocolVersion,
      }),
    hosted: () =>
      webPost("/api/web/conformance/connection-check", {
        ...buildServerRequest(serverName),
        protocolVersion,
      }),
  });
}

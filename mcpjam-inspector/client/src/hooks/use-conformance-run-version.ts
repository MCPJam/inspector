import type { ConformanceRunBudget } from "@/lib/apis/mcp-conformance-api";
import { useCallback, useRef } from "react";
import {
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import type { ServerWithName } from "./use-app-state";
import type { ProtocolVersionPin } from "./conformance-suite-state";
import { checkConformanceConnection } from "@/lib/apis/conformance-connection-api";

/** Include the URL so editing a target in place invalidates its old results. */
export function conformanceTargetKey(server: ServerWithName): string {
  const config = server.config;
  return JSON.stringify([
    server.name,
    config && "url" in config && config.url != null ? String(config.url) : null,
    config && "command" in config ? config.command : null,
    config && "args" in config && Array.isArray(config.args)
      ? config.args
      : null,
  ]);
}

/** Setup's result belongs to its first run only; reruns resolve a fresh connection. */
export function useConformanceRunVersion(
  server: ServerWithName,
  requested: ProtocolVersionPin,
  resolved?: McpProtocolVersion,
) {
  const initial = useRef({ server, requested, resolved });
  return useCallback(
    async (target: ServerWithName, version: ProtocolVersionPin, budget?: ConformanceRunBudget) => {
      budget?.signal?.throwIfAborted();
      if (!target.config || !("url" in target.config)) return undefined;
      const checked = initial.current;
      initial.current = {
        server: target,
        requested: version,
        resolved: undefined,
      };
      if (
        checked.resolved &&
        checked.requested === version &&
        (version === "auto" || checked.resolved === version) &&
        checked.server.name === target.name &&
        checked.server.config === target.config &&
        checked.server.oauthTokens === target.oauthTokens &&
        checked.server.lastConnectionTime === target.lastConnectionTime
      ) {
        return checked.resolved;
      }
      const result = await checkConformanceConnection(target.name, version, ...(budget?.signal ? [budget] : []));
      if (result.status === "ready") {
        if (!isKnownProtocolVersion(result.protocolVersion))
          throw new Error(
            "The connection did not resolve a supported protocol version. Choose a version and try again.",
          );
        return result.protocolVersion;
      }
      throw new Error(
        result.status === "unsupported"
          ? `The server doesn't support MCP protocol version ${result.protocolVersion}.${
              result.supportedVersions.length
                ? ` Supported versions: ${result.supportedVersions.join(", ")}.`
                : ""
            } Choose a supported version and try again.`
          : result.message,
      );
    },
    [],
  );
}

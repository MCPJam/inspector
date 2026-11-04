import type { RunConformanceConfig } from "./conformance-run.js";
import type { ConformanceReport } from "./conformance-reporting.js";
import type { ConformanceSuiteKind } from "./conformance-run-types.js";
import {
  AUTHORIZATION_REQUIRED_MESSAGE,
  authorizationRequiredDetails,
  isAuthorizationRefusal,
} from "./conformance-authorization.js";
import { withEphemeralClient } from "./operations.js";
import { withAbortSignalFetch } from "./abort-signal.js";
import {
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "./mcp-client-manager/mcp-protocol-version.js";

export function serverConfigFetch(
  server: RunConformanceConfig["server"]
): typeof fetch | undefined {
  return (
    server.fetchFn ?? ("baseFetch" in server ? server.baseFetch : undefined)
  );
}

export function requestedRunProtocolVersion(
  config: RunConformanceConfig
): McpProtocolVersion | undefined {
  return (
    config.protocolVersion ??
    ("mcpProtocolVersion" in config.server
      ? config.server.mcpProtocolVersion
      : undefined)
  );
}

/** Resolve Auto once before independent suites can negotiate different versions. */
export async function resolveRunProtocolVersion(
  config: RunConformanceConfig
): Promise<McpProtocolVersion | undefined> {
  const server = config.server;
  if (!("url" in server) || server.url == null) return undefined;
  config.protocol?.signal?.throwIfAborted();
  const pin = requestedRunProtocolVersion(config);
  if (pin !== undefined) {
    if (!isKnownProtocolVersion(pin))
      throw new Error(`Unknown protocol version: ${pin}`);
    return pin;
  }
  return withEphemeralClient(
    {
      ...server,
      baseFetch: withAbortSignalFetch(
        config.protocol?.fetchFn ?? serverConfigFetch(server) ?? fetch,
        config.protocol?.signal
      ),
      timeout: server.timeout ?? config.protocol?.checkTimeout,
    },
    async (manager, serverId) => {
      const negotiated = manager.getNegotiatedProtocolVersion(serverId);
      if (!negotiated || !isKnownProtocolVersion(negotiated)) {
        throw new Error(
          "The connection did not resolve a supported protocol version"
        );
      }
      return negotiated;
    }
  );
}

/** A connection failure leaves the requested checks untested, never passing. */
export function unresolvedVersionReport(
  kind: ConformanceSuiteKind,
  error: unknown
): ConformanceReport {
  const needsAuthorization = isAuthorizationRefusal(error);
  const message = needsAuthorization
    ? AUTHORIZATION_REQUIRED_MESSAGE
    : error instanceof Error
      ? error.message
      : String(error);
  return {
    schemaVersion: 1,
    kind: `${kind}-conformance`,
    name: kind,
    passed: false,
    outcome: "incomplete",
    incompleteReason: message,
    durationMs: 0,
    score: {
      score: null,
      outcome: "incomplete",
      applicable: 1,
      passed: 0,
      failed: 0,
      couldNotRun: 1,
      notApplicable: 0,
      pending: 0,
      advisories: [],
      advicePointsLost: 0,
    },
    groups: [
      {
        id: "connection",
        title: "Protocol connection",
        target: "",
        passed: false,
        durationMs: 0,
        cases: [
          {
            id: "protocol-version-unresolved",
            title: "Resolve the run protocol version",
            category: "connection",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            error: message,
            ...(needsAuthorization
              ? { details: authorizationRequiredDetails(error) }
              : {}),
          },
        ],
      },
    ],
  };
}

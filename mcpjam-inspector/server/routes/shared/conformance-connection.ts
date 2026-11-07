import { runWithinConformanceDeadline, deadlineFetch, type ConformanceDeadlineInput } from "./conformance-deadline.js";
import {
  describeError,
  isMCPAuthError,
  isKnownProtocolVersion,
  withEphemeralClient,
  type HttpServerConfig,
} from "@mcpjam/sdk";
import {
  readProtocolVersionRefusal,
  type ConformanceConnectionResult,
  type ConformanceProtocolSelection,
} from "../../../shared/conformance-connection.js";
import { HOSTED_MODE, WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import { describeHostedConnectFailure } from "../../utils/hosted-connect-failure.js";
import { createConformanceFetch } from "./conformance.js";
import { isProtocolVersionPinFailure } from "../../../shared/protocol-version-pin.js";

/** A separate client keeps a draft run's pin out of the main connection. */
export async function checkConformanceConnection(
  config: HttpServerConfig,
  protocolVersion: ConformanceProtocolSelection,
  budget: ConformanceDeadlineInput = {},
): Promise<ConformanceConnectionResult> {
  try {
    return await runWithinConformanceDeadline(budget, async (signal) => withEphemeralClient(
      {
        ...config,
        mcpProtocolVersion:
          protocolVersion === "auto" ? undefined : protocolVersion,
        supportedProtocolVersions:
          protocolVersion === "auto" ? undefined : [protocolVersion],
        timeout: WEB_CONNECT_TIMEOUT_MS,
        baseFetch: deadlineFetch(createConformanceFetch("MCP server"), signal),
      },
      async (manager, serverId): Promise<ConformanceConnectionResult> => {
        const negotiated = manager.getNegotiatedProtocolVersion(serverId);
        if (!negotiated || !isKnownProtocolVersion(negotiated)) {
          return {
            status: "failed",
            message:
              "The connection did not resolve a supported protocol version. Choose a version and try again.",
          };
        }
        if (protocolVersion !== "auto" && negotiated !== protocolVersion) {
          return {
            status: "unsupported",
            protocolVersion,
            supportedVersions: [negotiated],
          };
        }
        return { status: "ready", protocolVersion: negotiated };
      },
      { timeout: WEB_CONNECT_TIMEOUT_MS, signal },
    ));
  } catch (error) {
    const normalized = describeError(error);
    const refusal = readProtocolVersionRefusal(
      error,
      protocolVersion === "auto" ? undefined : protocolVersion,
    );
    if (
      protocolVersion !== "auto" &&
      (refusal || isProtocolVersionPinFailure(normalized))
    ) {
      return {
        status: "unsupported",
        protocolVersion,
        supportedVersions: refusal?.supportedVersions ?? [],
      };
    }
    const authRequired = isMCPAuthError(error)
      ? error.statusCode === undefined || error.statusCode === 401
      : normalized.slug === "auth/http_401" ||
        normalized.slug === "auth/missing_bearer" ||
        normalized.slug === "auth/oauth_refresh_failed";
    return {
      status: authRequired ? "auth-required" : "failed",
      message: HOSTED_MODE
        ? describeHostedConnectFailure(error).message
        : isMCPAuthError(error) && error.statusCode === 403
          ? "The server refused access (HTTP 403)."
          : normalized.oneLine,
    };
  }
}

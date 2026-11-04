import {
  describeError,
  isMCPAuthError,
  withEphemeralClient,
  type HttpServerConfig,
  type McpProtocolVersion,
} from "@mcpjam/sdk";
import {
  readProtocolVersionRefusal,
  type ConformanceConnectionResult,
} from "../../../shared/conformance-connection.js";
import { HOSTED_MODE, WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import { describeHostedConnectFailure } from "../../utils/hosted-connect-failure.js";
import { createConformanceFetch } from "./conformance.js";
import { isProtocolVersionPinFailure } from "../../../shared/protocol-version-pin.js";

/** A separate client keeps a draft run's pin out of the main connection. */
export async function checkConformanceConnection(
  config: HttpServerConfig,
  protocolVersion: McpProtocolVersion,
): Promise<ConformanceConnectionResult> {
  try {
    return await withEphemeralClient(
      {
        ...config,
        mcpProtocolVersion: protocolVersion,
        supportedProtocolVersions: [protocolVersion],
        timeout: WEB_CONNECT_TIMEOUT_MS,
        baseFetch: createConformanceFetch("MCP server"),
      },
      async (): Promise<ConformanceConnectionResult> => ({ status: "ready" }),
      { timeout: WEB_CONNECT_TIMEOUT_MS },
    );
  } catch (error) {
    const normalized = describeError(error);
    const refusal = readProtocolVersionRefusal(error, protocolVersion);
    if (refusal || isProtocolVersionPinFailure(normalized)) {
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

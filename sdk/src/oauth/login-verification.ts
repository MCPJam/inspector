import {
  parseChallengeHeader,
  type AuthChallengeSignal,
} from "../mcp-client-manager/auth-challenge.js";
import { extractAuthChallenge } from "../mcp-client-manager/errors.js";
import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import { listTools, withEphemeralClient } from "../operations.js";
import type {
  NormalizedOAuthConformanceConfig,
  VerificationResult,
} from "../oauth-conformance/types.js";
import type { OAuthFlowState } from "./state-machines/types.js";

export async function runLoginVerification(
  config: NormalizedOAuthConformanceConfig,
  state: OAuthFlowState,
  previous?: VerificationResult
): Promise<{
  verification?: VerificationResult;
  toolChallenge?: AuthChallengeSignal;
  unauthorizedChallenge?: AuthChallengeSignal;
}> {
  const verificationConfig = config.verification;
  if (!verificationConfig.listTools || !state.accessToken) {
    return {};
  }

  const result: VerificationResult = { ...previous };
  let toolChallenge: AuthChallengeSignal | undefined;
  let unauthorizedChallenge: AuthChallengeSignal | undefined;
  const resourceServer = new URL(config.serverUrl);
  const recordUnauthorized: typeof fetch = async (input, init) => {
    const response = await config.fetchFn(input, init);
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      response.status === 401 &&
      method.toUpperCase() === "POST" &&
      new URL(url).origin === resourceServer.origin
    ) {
      // server/discover can fail before a tool operation exists to carry the challenge.
      unauthorizedChallenge = parseChallengeHeader(
        response.headers.get("www-authenticate")
      );
    }
    return response;
  };
  const verifyConfig: HttpServerConfig = {
    url: config.serverUrl,
    accessToken: state.accessToken,
    requestInit: config.customHeaders
      ? { headers: config.customHeaders }
      : undefined,
    timeout: verificationConfig.timeout ?? 30_000,
    // Post-auth verification must speak the negotiated wire era. For 2026 the
    // MCP endpoint is stateless (no initialize), so pin the transport; older
    // OAuth flows keep the legacy default (unset) they used before.
    ...(config.protocolVersion === "2026-07-28"
      ? {
          mcpProtocolVersion: "2026-07-28" as const,
          baseFetch: recordUnauthorized,
        }
      : {}),
  };

  try {
    await withEphemeralClient(
      verifyConfig,
      async (manager, serverId) => {
        if (!previous) {
          const listStartedAt = Date.now();
          try {
            const toolsResult = await listTools(manager, { serverId });
            result.listTools = {
              passed: true,
              toolCount: toolsResult.tools.length,
              durationMs: Date.now() - listStartedAt,
            };
          } catch (error) {
            result.listTools = {
              passed: false,
              durationMs: Date.now() - listStartedAt,
              error: error instanceof Error ? error.message : String(error),
            };
            return;
          }
        }

        if (!verificationConfig.callTool) {
          return;
        }

        const callStartedAt = Date.now();
        try {
          await manager.executeTool(
            serverId,
            verificationConfig.callTool.name,
            verificationConfig.callTool.params ?? {}
          );
          result.callTool = {
            passed: true,
            toolName: verificationConfig.callTool.name,
            durationMs: Date.now() - callStartedAt,
          };
        } catch (error) {
          toolChallenge = extractAuthChallenge(error);
          result.callTool = {
            passed: false,
            toolName: verificationConfig.callTool.name,
            durationMs: Date.now() - callStartedAt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      {
        timeout: verificationConfig.timeout ?? 30_000,
      }
    );
  } catch (error) {
    if (previous && result.callTool) {
      result.callTool = {
        ...result.callTool,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } else if (!result.listTools) {
      result.listTools = {
        passed: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    verification: result,
    toolChallenge,
    unauthorizedChallenge:
      result.listTools?.passed === false || result.callTool?.passed === false
        ? unauthorizedChallenge
        : undefined,
  };
}

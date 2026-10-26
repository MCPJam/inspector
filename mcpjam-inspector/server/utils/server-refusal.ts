import type { PlatformChatTurn } from "@mcpjam/sdk/platform";
import { describeError } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

export type ServerRefusalReason = NonNullable<
  PlatformChatTurn["skippedServers"]
>[number]["reason"];

export function describeServerRefusal(input: {
  serverName: string;
  status: number;
  code: string;
  message: string;
  refusalReason?: string;
  oauthRequired?: boolean;
}): { reason: ServerRefusalReason; message: string } {
  const name = `"${input.serverName}"`;
  if (input.refusalReason === "hosted_requires_https") {
    return {
      reason: input.refusalReason,
      message: `${name} uses an http:// URL, which the hosted app can't reach. Use an https:// URL or run MCPJam locally.`,
    };
  }
  if (input.refusalReason === "hosted_stdio_unsupported") {
    return {
      reason: input.refusalReason,
      message: `${name} runs as a local command, which the hosted app can't start. Run MCPJam locally to use it.`,
    };
  }
  if (input.oauthRequired || input.status === 401) {
    return {
      reason: "needs_sign_in",
      message: `${name} needs you to sign in. Sign in from the Servers page, then try again.`,
    };
  }
  if (
    input.code === ErrorCode.SERVER_UNREACHABLE ||
    [502, 503, 504].includes(input.status)
  ) {
    return {
      reason: "unreachable",
      message: `MCPJam couldn't reach ${name}. Check that the server is running and its URL is correct.`,
    };
  }
  return {
    reason: "other",
    message: `${name} couldn't connect: ${input.message.replace(/\.+$/, "")}. Check the server's settings on the Servers page.`,
  };
}

/** Preserve the error's status, reporting source and retry headers. */
export function nameServerRefusal(
  error: unknown,
  serverId: string,
  serverName: string,
): void {
  if (
    !(error instanceof WebRouteError) ||
    error.code === ErrorCode.INTERNAL_ERROR ||
    (error.setupFailureSource === "secret_reveal" && error.status >= 500)
  )
    return;
  if (error.details?.serverRefusalReason) return;
  const described = describeServerRefusal({
    serverName,
    status: error.status,
    code: error.code,
    message: error.message,
    refusalReason:
      typeof error.details?.refusalReason === "string"
        ? error.details.refusalReason
        : undefined,
    oauthRequired: error.details?.oauthRequired === true,
  });
  // Refresh and policy refusals already name the server and the specific remedy.
  if (!error.details?.oauthUnavailableReason) error.message = described.message;
  error.details = {
    ...error.details,
    serverId,
    serverName,
    serverRefusalReason: described.reason,
  };
}

export function skippedServerDetails(
  failures: Readonly<Record<string, unknown>>,
  serverIds: readonly string[],
  serverNames?: readonly string[],
) {
  return serverIds.flatMap((serverId, index) => {
    if (!Object.hasOwn(failures, serverId)) return [];
    const error = failures[serverId];
    const serverName =
      serverNames?.[index] ??
      (error instanceof WebRouteError &&
      typeof error.details?.serverName === "string"
        ? error.details.serverName
        : serverId);
    nameServerRefusal(error, serverId, serverName);
    if (error instanceof WebRouteError && error.details?.serverRefusalReason) {
      return [
        {
          serverId,
          serverName,
          reason: String(error.details.serverRefusalReason),
          message: error.message,
        },
      ];
    }
    const verdict = describeError(error);
    const described = describeServerRefusal({
      serverName,
      status: verdict.slug.startsWith("auth/") ? 401 : 502,
      code: "",
      message: "Connection failed",
    });
    return [{ serverId, serverName, ...described }];
  });
}

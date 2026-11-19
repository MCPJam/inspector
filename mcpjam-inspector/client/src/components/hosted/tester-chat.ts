import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";

/**
 * Study rules for a tester on `/user-testing/<slug>/<token>`.
 *
 * One object, because the page used to reimplement the Playground send path
 * in `ChatTabV2` and every composer fix had to land twice. Guest access, the
 * locked study model, and the quiet chrome are configuration of the Playground
 * chat, not a second chat component.
 */
export type TesterChatRules = {
  hostedContext: HostedRuntimeContext;
  executionConfig: ExecutionConfig;
  selectedServerNames: string[];
  serverConfigs: Record<string, ServerWithName>;
  composerBlocked: boolean;
  composerBlockedReason?: string;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  optionalServers?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onEnableOptionalServer?: (serverId: string) => void;
  renderAssistantTurnActions?: (ctx: {
    message: UIMessage;
    chatSessionId: string;
    promptIndex: number;
    turnId: string | null;
  }) => ReactNode;
};

/** Names the composer may send. A server still connecting or proven down is omitted. */
export function connectedTesterServerNames(rules: TesterChatRules): string[] {
  return rules.selectedServerNames.filter(
    (name) => rules.serverConfigs[name]?.connectionStatus === "connected",
  );
}

export type OAuthRequiredFromChatError =
  | { required: false }
  | { required: true; details?: HostedOAuthRequiredDetails };

/**
 * A chat error that means the tester must authorize a server.
 * Structured `details.oauthRequired` wins; otherwise the server's known phrases.
 */
export function oauthRequiredFromChatError(
  error: unknown,
): OAuthRequiredFromChatError {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as {
      details?: {
        oauthRequired?: unknown;
        serverUrl?: unknown;
        serverId?: unknown;
        serverName?: unknown;
      };
    };
    if (parsed?.details?.oauthRequired) {
      return {
        required: true,
        details: {
          serverUrl:
            typeof parsed.details.serverUrl === "string"
              ? parsed.details.serverUrl
              : null,
          serverId:
            typeof parsed.details.serverId === "string"
              ? parsed.details.serverId
              : null,
          serverName:
            typeof parsed.details.serverName === "string"
              ? parsed.details.serverName
              : null,
        },
      };
    }
  } catch {
    // Plain text. Fall through to the phrase check.
  }

  const isOAuthError =
    /requires OAuth authentication/.test(message) ||
    (/Authentication failed/.test(message) && /invalid_token/.test(message));
  return isOAuthError ? { required: true } : { required: false };
}

/** When the error names no server and the study has exactly one, use that name. */
export function withSingleServerName(
  details: HostedOAuthRequiredDetails | undefined,
  serverNames: readonly string[],
): HostedOAuthRequiredDetails | undefined {
  const only = serverNames.length === 1 ? serverNames[0] : null;
  if (!only) return details;
  if (typeof details?.serverName === "string" && details.serverName.trim()) {
    return details;
  }
  return { ...details, serverName: only };
}

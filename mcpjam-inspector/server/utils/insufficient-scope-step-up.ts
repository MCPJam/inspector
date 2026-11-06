import type { ToolSet } from "ai";
import {
  emitInsufficientScopeChunk,
  emitScopeStepUpRequiredChunk,
  type ElicitationChunkWriter,
  type InsufficientScopeInfo,
} from "../routes/web/hosted-elicitation.js";
import type { ScopeStepUpRequiredEvent } from "@/shared/scope-step-up";
import { parseToolResultAuthChallenge } from "@mcpjam/sdk";
import {
  authChallengeInfoFromToolError,
  handleChatAuthChallenge,
  type AuthChallengeChatObserver,
} from "./auth-challenge-chat.js";
import { extractInsufficientScopeChallenge } from "./mcp-error-serialize.js";
import { ScopeStepUpSuspendSignal } from "./scope-step-up-continuation.js";

export { authChallengeInfoFromToolError } from "./auth-challenge-chat.js";

export type ScopeStepUpToolError = {
  error: unknown;
  serverId: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
};

export type ScopeStepUpObserverOptions = {
  /** Observe every tool error before scope-specific handling (for URL elicitation). */
  onToolError?: (context: ScopeStepUpToolError) => void;
  /** Override delivery while retaining the shared extraction/actionability gate. */
  emitInsufficientScope?: (info: InsufficientScopeInfo) => void;
  /**
   * Chat pause mode. Creates the server-side continuation for the exact
   * operation. When supplied, an actionable challenge is emitted through the
   * typed resumable data part and thrown as a suspension signal instead of
   * becoming a model-facing tool error.
   */
  createContinuation?: (input: {
    info: InsufficientScopeInfo;
    toolName: string;
    toolInput: unknown;
  }) => ScopeStepUpRequiredEvent | Promise<ScopeStepUpRequiredEvent>;
  /**
   * Mid-session sign-in (a 401, or a `_meta` challenge on a returned result).
   * Interactive chat turns only: a wrapper without it never reacts to either,
   * which keeps harness and non-interactive surfaces exactly as they were.
   */
  authChallenge?: AuthChallengeChatObserver;
};

/**
 * Convert a thrown MCP tool error into the actionable, serializable step-up
 * payload shared by both in-process tools and the harness proxy.
 */
export function scopeStepUpInfoFromToolError(
  context: ScopeStepUpToolError
): InsufficientScopeInfo | undefined {
  const challenge = extractInsufficientScopeChallenge(context.error);
  // A challenge with neither a scope nor a metadata pointer is actionable
  // too: the re-authorization falls back to the previously requested scopes
  // and discovery's `scopes_supported`, as Claude does.
  if (!challenge) {
    return undefined;
  }
  return {
    serverId: context.serverId,
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    ...challenge,
  };
}

/**
 * Observe in-process chat tool failures and surface actionable SEP-2350 scope
 * challenges before the AI SDK turns them into model-facing error text.
 *
 * The writer is late-bound because tool preparation completes before the
 * stream starts. Tool errors are always rethrown so this wrapper only observes
 * execution; the existing tool-loop error handling remains authoritative.
 *
 * Harness MCP-server tools execute out of process through the generated
 * `.mcp.json`; their proxy path calls {@link scopeStepUpInfoFromToolError}
 * directly and forwards the result through the harness turn bridge.
 *
 * With `authChallenge` (interactive chat only), a mid-session sign-in
 * challenge, thrown as a 401 or returned as a `_meta` result, is handed to
 * `handleChatAuthChallenge`, which may suspend the call, answer it with the
 * host's sign-in text, or let it through unchanged. A 403 step-up never
 * reaches it.
 */
export function wrapToolsWithScopeStepUp<TTools extends ToolSet>(
  tools: TTools,
  getScopeChallengeWriter: () => ElicitationChunkWriter | null,
  observerOptions: ScopeStepUpObserverOptions = {}
): TTools {
  return Object.fromEntries(
    Object.entries(tools as Record<string, any>).map(([name, tool]) => {
      if (typeof tool?.execute !== "function") return [name, tool];

      const execute = tool.execute.bind(tool);
      return [
        name,
        {
          ...tool,
          execute: async (input: unknown, options: any) => {
            const serverId = tool._serverId ?? "unknown";
            const toolCallId = options?.toolCallId;
            // The server's own name: a multi-account variant renames the chat
            // tool, while annotations and `securitySchemes` are declared under
            // the original.
            const mcpToolName =
              typeof tool._mcpToolName === "string" ? tool._mcpToolName : name;
            let result: unknown;
            try {
              result = await execute(input, options);
            } catch (error) {
              observerOptions.onToolError?.({ error, serverId, toolCallId });

              const info = scopeStepUpInfoFromToolError({
                error,
                serverId,
                toolCallId,
              });
              if (info?.toolCallId && observerOptions.createContinuation) {
                const event = await observerOptions.createContinuation({
                  info,
                  toolName: name,
                  toolInput: input,
                });
                emitScopeStepUpRequiredChunk(getScopeChallengeWriter(), event);
                throw new ScopeStepUpSuspendSignal(event);
              }
              if (info) {
                if (observerOptions.emitInsufficientScope) {
                  observerOptions.emitInsufficientScope(info);
                } else {
                  emitInsufficientScopeChunk(
                    getScopeChallengeWriter(),
                    undefined,
                    info
                  );
                }
              }
              const authChallenge = observerOptions.authChallenge;
              const authInfo =
                !info && authChallenge
                  ? authChallengeInfoFromToolError({
                      error,
                      serverId,
                      toolCallId,
                      effectiveAuth: authChallenge.effectiveAuthFor(serverId),
                    })
                  : undefined;
              if (authChallenge && authInfo) {
                const outcome = await handleChatAuthChallenge({
                  observer: authChallenge,
                  writer: getScopeChallengeWriter(),
                  signal: authInfo.signal,
                  serverId,
                  toolCallId,
                  toolName: name,
                  mcpToolName,
                  toolInput: input,
                });
                if (outcome.kind === "result") return outcome.result;
              }
              throw error;
            }

            const authChallenge = observerOptions.authChallenge;
            const resultChallenge = authChallenge
              ? parseToolResultAuthChallenge(result)
              : undefined;
            if (authChallenge && resultChallenge) {
              const outcome = await handleChatAuthChallenge({
                observer: authChallenge,
                writer: getScopeChallengeWriter(),
                signal: resultChallenge,
                serverId,
                toolCallId,
                toolName: name,
                mcpToolName,
                toolInput: input,
              });
              if (outcome.kind === "result") return outcome.result;
            }
            return result;
          },
        },
      ];
    })
  ) as TTools;
}

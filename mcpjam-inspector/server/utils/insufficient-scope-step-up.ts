import type { ToolSet } from "ai";
import {
  emitInsufficientScopeChunk,
  emitScopeStepUpRequiredChunk,
  type ElicitationChunkWriter,
  type InsufficientScopeInfo,
} from "../routes/web/hosted-elicitation.js";
import type { ScopeStepUpRequiredEvent } from "@/shared/scope-step-up";
import { extractInsufficientScopeChallenge } from "./mcp-error-serialize.js";
import { ScopeStepUpSuspendSignal } from "./scope-step-up-continuation.js";

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
};

/**
 * Convert a thrown MCP tool error into the actionable, serializable step-up
 * payload shared by both in-process tools and the harness proxy.
 */
export function scopeStepUpInfoFromToolError(
  context: ScopeStepUpToolError
): InsufficientScopeInfo | undefined {
  const challenge = extractInsufficientScopeChallenge(context.error);
  if (
    !challenge ||
    (!challenge.requiredScope?.trim() && !challenge.resourceMetadataUrl?.trim())
  ) {
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
            try {
              return await execute(input, options);
            } catch (error) {
              const serverId = tool._serverId ?? "unknown";
              const toolCallId = options?.toolCallId;
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
              throw error;
            }
          },
        },
      ];
    })
  ) as TTools;
}

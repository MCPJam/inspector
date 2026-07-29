import type { ToolSet } from "ai";
import {
  emitInsufficientScopeChunk,
  type ElicitationChunkWriter,
  type InsufficientScopeInfo,
} from "../routes/web/hosted-elicitation.js";
import { extractInsufficientScopeChallenge } from "./mcp-error-serialize.js";

export type ScopeStepUpToolError = {
  error: unknown;
  serverId: string;
  toolCallId?: string;
};

export type ScopeStepUpObserverOptions = {
  /** Observe every tool error before scope-specific handling (for URL elicitation). */
  onToolError?: (context: ScopeStepUpToolError) => void;
  /** Override delivery while retaining the shared extraction/actionability gate. */
  emitInsufficientScope?: (info: InsufficientScopeInfo) => void;
};

/**
 * Observe in-process chat tool failures and surface actionable SEP-2350 scope
 * challenges before the AI SDK turns them into model-facing error text.
 *
 * The writer is late-bound because tool preparation completes before the
 * stream starts. Tool errors are always rethrown so this wrapper only observes
 * execution; the existing tool-loop error handling remains authoritative.
 *
 * Contract boundary: harness MCP-server tools execute out of process through
 * the generated `.mcp.json`, not through this ToolSet. Supporting scope step-up
 * there requires a correlated harness-proxy-to-chat side channel.
 */
export function wrapToolsWithScopeStepUp<TTools extends ToolSet>(
  tools: TTools,
  getScopeChallengeWriter: () => ElicitationChunkWriter | null,
  observerOptions: ScopeStepUpObserverOptions = {},
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

              const challenge = extractInsufficientScopeChallenge(error);
              if (
                challenge &&
                (challenge.requiredScope?.trim() ||
                  challenge.resourceMetadataUrl?.trim())
              ) {
                const info = { serverId, toolCallId, ...challenge };
                if (observerOptions.emitInsufficientScope) {
                  observerOptions.emitInsufficientScope(info);
                } else {
                  emitInsufficientScopeChunk(
                    getScopeChallengeWriter(),
                    undefined,
                    info,
                  );
                }
              }
              throw error;
            }
          },
        },
      ];
    }),
  ) as TTools;
}

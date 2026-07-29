import type { ToolSet } from "ai";
import {
  emitInsufficientScopeChunk,
  type ElicitationChunkWriter,
} from "../routes/web/hosted-elicitation.js";
import { extractInsufficientScopeChallenge } from "./mcp-error-serialize.js";

/**
 * Observe local-chat tool failures and surface actionable SEP-2350 scope
 * challenges on the chat stream before the AI SDK turns them into model-facing
 * error text.
 *
 * The writer is late-bound because tool preparation completes before the
 * stream starts. Tool errors are always rethrown so this wrapper only observes
 * execution; the existing tool-loop error handling remains authoritative.
 */
export function wrapToolsWithScopeStepUp<TTools extends ToolSet>(
  tools: TTools,
  getScopeChallengeWriter: () => ElicitationChunkWriter | null,
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
              const challenge = extractInsufficientScopeChallenge(error);
              if (
                challenge &&
                (challenge.requiredScope?.trim() ||
                  challenge.resourceMetadataUrl?.trim())
              ) {
                emitInsufficientScopeChunk(
                  getScopeChallengeWriter(),
                  undefined,
                  {
                    serverId: tool._serverId ?? "unknown",
                    toolCallId: options?.toolCallId,
                    ...challenge,
                  },
                );
              }
              throw error;
            }
          },
        },
      ];
    }),
  ) as TTools;
}

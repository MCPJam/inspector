const QUERY_OPTIONS = "      hooks: {\n        PreToolUse: [";
const ABORT = '      case "abort":\n        turnAbort?.abort();';

/** The pinned SDK callback uses the bridge's existing result-control channel. */
export function patchClaudeCodeElicitation(content: string): string {
  if (!content.includes(QUERY_OPTIONS) || !content.includes(ABORT)) {
    throw new Error(
      "Unable to patch Claude Code elicitation: bridge shape changed",
    );
  }
  return content
    .replace(
      QUERY_OPTIONS,
      `      ...(start.env?.MCPJAM_HARNESS_ELICITATION === "1" ? {
        onElicitation: async (request, options) => {
          const controlId = "mcpjam:elicitation:" + options.requestId;
          const pending = turn.requestToolResult({ toolCallId: controlId });
          const cancel = () => emit({ type: "raw", rawValue: {
            type: "mcpjam:elicitation", phase: "cancel", controlId
          } });
          options.signal.addEventListener("abort", cancel, { once: true });
          emit({ type: "raw", rawValue: {
            type: "mcpjam:elicitation", phase: "request", controlId, request
          } });
          if (options.signal.aborted) cancel();
          try {
            const { output } = await pending;
            if (!output || !["accept", "decline", "cancel"].includes(output.action))
              return { action: "cancel" };
            return output.action === "accept" && request.mode !== "url"
              ? { action: "accept", ...(output.content ? { content: output.content } : {}) }
              : { action: output.action };
          } finally {
            options.signal.removeEventListener("abort", cancel);
          }
        }
      } : {}),
${QUERY_OPTIONS}`,
    )
    .replace(
      ABORT,
      `${ABORT}
        for (const [id, pending] of pendingToolResults) {
          if (!id.startsWith("mcpjam:elicitation:")) continue;
          pendingToolResults.delete(id);
          pending.resolve({ output: { action: "cancel" } });
        }`,
    );
}

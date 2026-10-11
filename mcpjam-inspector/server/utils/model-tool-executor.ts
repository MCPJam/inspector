import type { ToolSet } from "ai";

export type ModelToolExecution = {
  serverKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  signal?: AbortSignal;
};
export type ModelToolExecutor = (
  execution: ModelToolExecution,
  run: () => Promise<unknown>,
) => Promise<unknown>;

/** Wrap only the live execute callback. Listing, history and model-output conversion
 * cannot enter it. The AI SDK's existing approval remains outside execute. */
export function wrapModelToolsets(
  groups: Record<string, ToolSet>,
  executor?: ModelToolExecutor,
): Record<string, ToolSet> {
  if (!executor) return groups;
  return Object.fromEntries(
    Object.entries(groups).map(([serverKey, tools]) => [
      serverKey,
      Object.fromEntries(
        Object.entries(tools).map(([toolName, tool]) => {
          if (!tool.execute) return [toolName, tool];
          const execute = tool.execute.bind(tool);
          return [
            toolName,
            {
              ...tool,
              execute: (
                input: unknown,
                options: Parameters<typeof execute>[1],
              ) =>
                executor(
                  {
                    serverKey,
                    toolName,
                    input,
                    toolCallId: options.toolCallId,
                    signal: options.abortSignal,
                  },
                  async () => execute(input, options),
                ),
            },
          ];
        }),
      ),
    ]),
  );
}

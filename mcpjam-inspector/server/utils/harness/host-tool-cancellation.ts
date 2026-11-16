type ExecutionOptions = { toolCallId: string; abortSignal?: AbortSignal };
type ExecutableTool = { execute?: (input: unknown, options: ExecutionOptions) => unknown };

/** Route a bridge cancellation to one host execution, including an early cancel. */
export function createHostToolCancellation() {
  const running = new Map<string, AbortController>();
  const cancelled = new Set<string>();
  return {
    cancel(value: unknown): boolean {
      if (!value || typeof value !== "object" ||
        !("type" in value) || value.type !== "mcpjam-host-tool-cancel" ||
        !("toolCallId" in value) || typeof value.toolCallId !== "string" || !value.toolCallId) return false;
      if (cancelled.size >= 256) throw new Error("Too many cancelled host tool calls in this turn.");
      cancelled.add(value.toolCallId);
      running.get(value.toolCallId)?.abort(new Error("The runtime cancelled this tool call."));
      return true;
    },
    wrap(tools: Record<string, unknown>): Record<string, unknown> {
      return Object.fromEntries(Object.entries(tools).map(([name, value]) => {
        if (!value || typeof value !== "object") return [name, value];
        const tool = value as ExecutableTool;
        const execute = tool.execute?.bind(tool);
        if (!execute) return [name, value];
        return [name, { ...value, execute: async (input: unknown, options: ExecutionOptions) => {
          const controller = new AbortController();
          if (cancelled.has(options.toolCallId)) controller.abort(new Error("The runtime cancelled this tool call."));
          const signal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal;
          signal.throwIfAborted();
          running.set(options.toolCallId, controller);
          try {
            const result = await execute(input, { ...options, abortSignal: signal });
            signal.throwIfAborted();
            return result;
          } finally {
            running.delete(options.toolCallId);
          }
        } }];
      }));
    },
  };
}

import { randomUUID } from "node:crypto";
import { tool, type ToolSet, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ToolPolicyGate } from "./tool-policy-gate.js";

/** Reuse the full gate, including the benchmark manifest, at actual dispatch. */
async function dispatch(
  gate: ToolPolicyGate | null | undefined,
  serverId: string,
  name: string,
  input: Record<string, unknown>,
  execute: () => Promise<unknown>,
  options: ToolExecutionOptions<unknown> = {
    toolCallId: randomUUID(),
    messages: [],
    context: undefined,
  },
) {
  if (!gate) return execute();
  const candidate = Object.assign(
    tool({ inputSchema: z.record(z.string(), z.unknown()), execute }),
    { _serverId: serverId },
  );
  const guarded = gate.wrap({ [name]: candidate })[name];
  if (!guarded.execute) throw new Error("Policy guard has no executor");
  return guarded.execute(input, options);
}

/** Installed once before any render, so timers and carried views use it too. */
export function evalWidgetServerCall(
  gate: ToolPolicyGate | null | undefined,
  manager: Pick<MCPClientManager, "executeTool">,
) {
  return (serverId: string, name: string, input: Record<string, unknown>) =>
    dispatch(gate, serverId, name, input, () =>
      manager.executeTool(serverId, name, input),
    );
}

export function guardEvalViewTools(
  tools: ToolSet,
  gate: ToolPolicyGate | null | undefined,
): ToolSet {
  const call = tools.widget_call_tool;
  if (!call?.execute) return tools;
  const execute = call.execute;
  return {
    ...tools,
    widget_call_tool: {
      ...call,
      execute: async (input, options) => {
        if (
          !input ||
          typeof input !== "object" ||
          !("name" in input) ||
          typeof input.name !== "string" ||
          !("arguments" in input) ||
          !input.arguments ||
          typeof input.arguments !== "object" ||
          Array.isArray(input.arguments)
        ) {
          throw new Error("Invalid view tool call");
        }
        // No server annotations can classify code supplied by the view.
        return dispatch(
          gate,
          "mcpjam:view",
          input.name,
          input.arguments as Record<string, unknown>,
          async () => execute(input, options),
          options,
        );
      },
    },
  };
}

import type { MCPClientCheckDefinition } from "../types.js";
import {
  errorMessage,
  failedResult,
  passedResult,
} from "./helpers.js";

export const TOOL_CHECKS: MCPClientCheckDefinition[] = [
  {
    id: "tools-list",
    category: "tools",
    title: "Tools List",
    description: "Server lists tools with name, description, and input schema.",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.listTools(ctx.serverId);
        const invalidTools = (result.tools ?? [])
          .map((tool, index) => ({ tool, index }))
          .filter(({ tool }) => !tool.name || !tool.inputSchema)
          .map(({ index }) => index);

        if (invalidTools.length > 0) {
          return failedResult(
            this,
            Date.now() - startedAt,
            `Invalid tool definitions at indexes: ${invalidTools.join(", ")}`,
            {
              toolCount: result.tools?.length ?? 0,
            },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          toolCount: result.tools?.length ?? 0,
          toolNames: (result.tools ?? []).map((tool) => tool.name),
        });
      } catch (error) {
        return failedResult(
          this,
          Date.now() - startedAt,
          errorMessage(error),
          undefined,
          error,
        );
      }
    },
  },
];

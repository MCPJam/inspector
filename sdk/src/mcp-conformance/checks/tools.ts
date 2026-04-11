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
  {
    id: "tools-input-schemas-valid",
    category: "tools",
    title: "Tool Input Schemas Valid",
    description:
      "Every tool's inputSchema has type \"object\" and valid properties/required fields.",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.listTools(ctx.serverId);
        const tools = result.tools ?? [];

        if (tools.length === 0) {
          return passedResult(this, Date.now() - startedAt, {
            toolCount: 0,
          });
        }

        const violations: Array<{ tool: string; reason: string }> = [];

        for (const tool of tools) {
          const schema = tool.inputSchema as Record<string, unknown> | undefined;
          if (!schema) {
            violations.push({ tool: tool.name, reason: "missing inputSchema" });
            continue;
          }

          if (
            schema.type !== undefined &&
            schema.type !== "object"
          ) {
            violations.push({
              tool: tool.name,
              reason: `inputSchema.type is "${String(schema.type)}", expected "object"`,
            });
          }

          if (
            schema.properties !== undefined &&
            (typeof schema.properties !== "object" ||
              schema.properties === null ||
              Array.isArray(schema.properties))
          ) {
            violations.push({
              tool: tool.name,
              reason: "inputSchema.properties is not a plain object",
            });
          }

          if (
            schema.required !== undefined &&
            !Array.isArray(schema.required)
          ) {
            violations.push({
              tool: tool.name,
              reason: "inputSchema.required is not an array",
            });
          }
        }

        if (violations.length > 0) {
          return failedResult(
            this,
            Date.now() - startedAt,
            `${violations.length} tool(s) have invalid inputSchema: ${violations.map((v) => `${v.tool} (${v.reason})`).join(", ")}`,
            { violations },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          toolCount: tools.length,
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

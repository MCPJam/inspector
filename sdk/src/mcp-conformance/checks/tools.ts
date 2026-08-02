import { scanXMcpHeaderDeclarations } from "../../mcp-client-manager/mcp-header-mirror.js";
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
        const result = await ctx.manager.listTools(ctx.serverId, undefined, { cacheMode: "bypass" });
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
        const result = await ctx.manager.listTools(ctx.serverId, undefined, { cacheMode: "bypass" });
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
  {
    id: "tools-x-mcp-header-declarations-valid",
    category: "tools",
    title: "x-mcp-header Declarations Valid",
    description:
      "Every tool's SEP-2243 x-mcp-header declarations satisfy the spec's constraints (statically reachable through properties, RFC 9110 token name, primitive type, case-insensitively unique).",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.listTools(ctx.serverId, undefined, {
          cacheMode: "bypass",
        });
        const tools = result.tools ?? [];

        // Read-only, and deliberately so: this judges the DEFINITIONS a
        // `tools/list` already returned. It calls no tool and sends no probe,
        // so it is safe against a server with side-effecting tools.
        const violations: Array<{ tool: string; reason: string }> = [];
        let declaringTools = 0;

        for (const tool of tools) {
          if (tool.inputSchema === undefined) continue;
          const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
          if (!scan.valid) {
            violations.push({ tool: tool.name, reason: scan.reason });
            continue;
          }
          if (scan.declarations.length > 0) declaringTools += 1;
        }

        if (violations.length > 0) {
          return failedResult(
            this,
            Date.now() - startedAt,
            // The spec's consequence is severe and worth naming in the
            // message: a conforming client treats such a tool as INVALID —
            // it does not merely skip the header.
            `${violations.length} tool(s) carry invalid x-mcp-header declarations; a conforming client MUST treat those tool definitions as invalid: ${violations
              .map((v) => `${v.tool} (${v.reason})`)
              .join(", ")}`,
            { violations },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          toolCount: tools.length,
          declaringTools,
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

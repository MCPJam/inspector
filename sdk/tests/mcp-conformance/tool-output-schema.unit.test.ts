/**
 * Tool Output Schema Honored, on the question of which schemas it can read.
 *
 * The validator handles JSON Schema 2020-12 and draft-07. For any other
 * dialect it validates nothing and accepts every value, so a result judged
 * under such a schema was never checked. These tests drive the check with a
 * scripted `fetch`, one tool per dialect, to pin down that an unreadable
 * schema is reported as not checked and a readable one is still graded.
 */

import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const ID: MCPCheckId = "modern-tool-output-schema-conformant";

const DRAFT_2019_09 = "https://json-schema.org/draft/2019-09/schema";
const DRAFT_04 = "http://json-schema.org/draft-04/schema#";

/** Every tool promises `{ value: string }`; only the dialect differs. */
function outputSchema($schema?: unknown) {
  return {
    ...($schema === undefined ? {} : { $schema }),
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  };
}

interface ScriptedTool {
  name: string;
  outputSchema: Record<string, unknown>;
  /** What the tool returns as `structuredContent`. */
  returns: Record<string, unknown>;
}

const BROKEN = { value: 7 };
const CONFORMING = { value: "ok" };

function scriptedFetch(tools: ScriptedTool[]): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const ok = (result: Record<string, unknown>) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { resultType: "complete", ...result },
        }),
        { headers: { "Content-Type": "application/json" } }
      );

    switch (body.method) {
      case "server/discover":
        return ok({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        });
      case "tools/list":
        return ok({
          tools: tools.map((tool) => ({
            name: tool.name,
            inputSchema: { type: "object", properties: {} },
            outputSchema: tool.outputSchema,
          })),
        });
      case "tools/call": {
        const called = tools.find((tool) => tool.name === body.params?.name);
        return ok({
          content: [{ type: "text", text: "done" }],
          structuredContent: called?.returns,
        });
      }
      default:
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Method not found" },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
    }
  };
}

async function runCheck(tools: ScriptedTool[]) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://schemas.example.test/mcp",
    protocolVersion: "2026-07-28",
    fixtures: { toolCalls: tools.map((tool) => ({ toolName: tool.name })) },
    fetchFn: scriptedFetch(tools),
  });
  const results = await runModernChecks(
    { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn },
    new Set([ID])
  );
  return results[0];
}

describe("an output schema in a dialect the check cannot read", () => {
  it("is not checked, costs no point, and is named in the message", async () => {
    const check = await runCheck([
      {
        name: "region",
        outputSchema: outputSchema(DRAFT_2019_09),
        returns: BROKEN,
      },
    ]);

    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(check.error?.message).toBe(
      `This check reads output schemas written in JSON Schema 2020-12 or draft-07. It could not read the output schema of "region" (${DRAFT_2019_09}), so that result was not checked. Pick a tool whose output schema uses 2020-12 or draft-07, then run again.`
    );
    expect(check.details).toMatchObject({
      // A setup gap: gray "Not run", and the same text is the fix shown.
      missingInput: "toolCallProbe",
      missingInputMessage: check.error?.message,
      unsupportedDialects: [{ tool: "region", dialect: DRAFT_2019_09 }],
      graded: [{ tool: "region", schemaBound: false }],
      problems: [],
    });
  });

  it("reports every tool, including a second one in the same dialect", async () => {
    // The validator announces an unknown dialect once, not once per schema, so
    // the second tool is the one a careless fix would let through as a pass.
    const check = await runCheck([
      {
        name: "first",
        outputSchema: outputSchema(DRAFT_2019_09),
        returns: BROKEN,
      },
      {
        name: "second",
        outputSchema: outputSchema(DRAFT_2019_09),
        returns: BROKEN,
      },
      { name: "third", outputSchema: outputSchema(DRAFT_04), returns: BROKEN },
    ]);

    expect(check).toMatchObject({
      status: "skipped",
      skipReason: "could-not-run",
    });
    expect(check.details).toMatchObject({
      unsupportedDialects: [
        { tool: "first", dialect: DRAFT_2019_09 },
        { tool: "second", dialect: DRAFT_2019_09 },
        { tool: "third", dialect: DRAFT_04 },
      ],
    });
    expect(check.error?.message).toContain("so those results were not checked");
  });
});

describe("an output schema in a dialect the check can read", () => {
  const readable: Array<[string, unknown]> = [
    ["no $schema (2020-12 by default)", undefined],
    ["2020-12", "https://json-schema.org/draft/2020-12/schema"],
    ["draft-07", "http://json-schema.org/draft-07/schema#"],
    // Not a dialect at all, so the schema falls back to the default one.
    ["a $schema that is not a string", 7],
  ];

  for (const [label, $schema] of readable) {
    it(`${label}: a conforming result passes`, async () => {
      const check = await runCheck([
        {
          name: "tool",
          outputSchema: outputSchema($schema),
          returns: CONFORMING,
        },
      ]);
      expect([check.status, check.error?.message]).toEqual([
        "passed",
        undefined,
      ]);
      expect(check.details).toMatchObject({
        graded: [{ tool: "tool", schemaBound: true }],
      });
    });

    it(`${label}: a breaking result fails`, async () => {
      const check = await runCheck([
        { name: "tool", outputSchema: outputSchema($schema), returns: BROKEN },
      ]);
      expect(check.status).toBe("failed");
      expect(check.error?.message).toContain("does not conform");
    });
  }
});

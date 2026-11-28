/**
 * Client rules about JSON Schema: which dialect a schema is validated by,
 * validating a tool's structured result against its output schema, how `$ref`
 * is resolved, and warning when a tool is dropped for a bad `x-mcp-header`.
 *
 * The validator rules run on MCPJam's two dialect-aware validators (the Ajv
 * one for Node, the CSP-safe one for browsers and workers). The tool rules
 * run MCPClientManager against small low-level servers that send exactly the
 * tool definitions and results each rule is about.
 */

import { afterEach, describe, expect, vi } from "vitest";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { DialectAwareJsonSchemaValidator } from "../../src/mcp-client-manager/dialect-aware-json-schema-validator.js";
import { CspSafeDialectAwareJsonSchemaValidator } from "../../src/mcp-client-manager/csp-safe-dialect-aware-json-schema-validator.js";
import { exercised, ruleTest } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A low-level server that lists `tools` as given and answers calls with `result`. */
function toolServer(tools: unknown[], result: unknown = { content: [] }) {
  return createMcpHandler(() => {
    const server = new Server(
      { name: "client-rules-tools", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", () => ({ tools }) as never);
    server.setRequestHandler("tools/call", () => result as never);
    return server;
  });
}

async function connect(
  handler: ReturnType<typeof toolServer>,
  era: "2025-11-25" | "2026-07-28",
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  await manager.connectToServer("tools", {
    url: "http://localhost/mcp",
    mcpProtocolVersion: era,
    baseFetch: (input, init) => handler.fetch(new Request(input, init)),
    timeout: 10_000,
  });
  return manager;
}

describe.each([
  ["Ajv (Node)", DialectAwareJsonSchemaValidator],
  ["CSP-safe (browser, workers)", CspSafeDialectAwareJsonSchemaValidator],
] as const)("dialects, %s validator", (_name, Validator) => {
  // Each schema uses a keyword only its own dialect knows. A validator that
  // used the other dialect would ignore the keyword and accept { a: 1 }.
  ruleTest("C016", "validates a schema that declares draft-07 by draft-07", () => {
    const validate = new Validator().getValidator({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      dependencies: { a: ["b"] },
    });
    expect(validate({ a: 1, b: 2 }).valid).toBe(true);
    expect(validate({ a: 1 }).valid).toBe(false);
  });

  ruleTest("C016", "validates a schema with no $schema by the default, 2020-12", () => {
    const validate = new Validator().getValidator({
      type: "object",
      dependentRequired: { a: ["b"] },
    });
    expect(validate({ a: 1, b: 2 }).valid).toBe(true);
    expect(validate({ a: 1 }).valid).toBe(false);
  });
});

describe.each([
  ["Ajv (Node)", DialectAwareJsonSchemaValidator],
  ["CSP-safe (browser, workers)", CspSafeDialectAwareJsonSchemaValidator],
] as const)("$ref resolution, %s validator", (_name, Validator) => {
  ruleTest(
    "C057",
    "never fetches a network $ref, and does not treat it as permissive",
    () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const schema = {
        type: "object",
        properties: { name: { $ref: "https://schemas.example.invalid/name.json" } },
        required: ["name"],
      };
      let outcome: "refused" | "permissive" | "validated";
      try {
        const validate = new Validator().getValidator(schema);
        // Anything goes through a permissive validator, even a number.
        outcome = validate({ name: 5 }).valid ? "permissive" : "validated";
      } catch {
        outcome = "refused";
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(outcome).not.toBe("permissive");
    },
  );
});

describe.each(["2025-11-25", "2026-07-28"] as const)("tool results and definitions on %s", (era) => {
  ruleTest(
    "C056",
    "refuses a structured result that breaks the tool's output schema",
    async () => {
      const handler = toolServer(
        [
          {
            name: "greet",
            inputSchema: { type: "object", properties: {} },
            outputSchema: {
              type: "object",
              properties: { greeting: { type: "string" } },
              required: ["greeting"],
            },
          },
        ],
        { content: [{ type: "text", text: "5" }], structuredContent: { greeting: 5 } },
      );
      const manager = await connect(handler, era);
      try {
        await manager.listTools("tools");
        await expect(manager.executeTool("tools", "greet", {})).rejects.toThrow(
          /structured|schema|output/i,
        );
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }
    },
  );
});

describe("dropping a tool for a bad x-mcp-header (2026-07-28)", () => {
  ruleTest(
    "C017",
    "warns with the tool's name and the reason when it drops the tool",
    async (context) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handler = toolServer([
        {
          name: "good-tool",
          inputSchema: { type: "object", properties: { region: { type: "string" } } },
        },
        {
          name: "bad-header-tool",
          inputSchema: {
            type: "object",
            // An empty name is one of the x-mcp-header constraints a client
            // MUST reject the whole tool definition for.
            properties: { region: { type: "string", "x-mcp-header": "" } },
          },
        },
      ]);
      const manager = await connect(handler, "2026-07-28");
      let names: string[];
      try {
        names = (await manager.listTools("tools")).tools.map((tool) => tool.name);
      } finally {
        await manager.disconnectAllServers().catch(() => {});
      }
      // Dropping the tool is a separate MUST (C215); this rule is the warning.
      exercised(context, !names.includes("bad-header-tool"), "the client kept the tool");
      const warnings = warn.mock.calls.map((call) => call.map(String).join(" "));
      // The reason names the property and the constraint it breaks.
      expect(
        warnings.some(
          (text) =>
            text.includes("bad-header-tool") && text.includes("region") && /empty/i.test(text),
        ),
        `console.warn calls: ${JSON.stringify(warnings)}`,
      ).toBe(true);
    },
  );
});

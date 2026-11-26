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
import { coveredBy, ruleTest } from "./harness.js";

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

describe("validating by the declared or default dialect", () => {
  coveredBy(
    "C016",
    "tests/dialect-aware-json-schema-validator.test.ts",
    "validates declared draft-07 schemas instead of rejecting them",
  );
  coveredBy(
    "C016",
    "tests/dialect-aware-json-schema-validator.test.ts",
    "validates schemas with no $schema as 2020-12",
  );
});

describe.each([
  ["Ajv (Node)", DialectAwareJsonSchemaValidator],
  ["CSP-safe (browser, workers)", CspSafeDialectAwareJsonSchemaValidator],
] as const)("$ref resolution, %s validator", (_name, Validator) => {
  ruleTest("C057", "resolves a local $ref into $defs and validates through it", () => {
    const validate = new Validator().getValidator({
      type: "object",
      $defs: { name: { type: "string", minLength: 1 } },
      properties: { name: { $ref: "#/$defs/name" } },
      required: ["name"],
    });
    expect(validate({ name: "ada" }).valid).toBe(true);
    expect(validate({ name: 5 }).valid).toBe(false);
    expect(validate({ name: "" }).valid).toBe(false);
  });

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
    async () => {
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
      // The drop itself (a MUST, graded by MCP Conformance as well).
      expect(names).toEqual(["good-tool"]);
      const warnings = warn.mock.calls.map((call) => call.map(String).join(" "));
      expect(
        warnings.some(
          (text) => text.includes("bad-header-tool") && /x-mcp-header/i.test(text),
        ),
        `console.warn calls: ${JSON.stringify(warnings)}`,
      ).toBe(true);
    },
  );
});

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody, requestId } from "../support/json-rpc-fixture.js";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
  type MCPConformanceFixtures,
} from "../../src/mcp-conformance/index.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";

const MODERN = "2026-07-28" as const;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { temperature: { type: "number" } },
  required: ["temperature"],
} as const;

const DRAFT_07_OUTPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
} as const;

interface FixtureServerOptions {
  /** What `tools/call` returns for `weather`. */
  weatherResult?: Record<string, unknown>;
  /** What `tools/call` returns for `city` (draft-07 output schema). */
  cityResult?: Record<string, unknown>;
  /** Record every method the server was asked for. */
  calls?: string[];
}

async function serveFixtureServer(options: FixtureServerOptions) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const parsed = await readJsonRpcBody(req, res);
      if (!parsed) return;
      const id = requestId(parsed);
      const method = parsed.method ?? "";
      options.calls?.push(
        method === "tools/call" || method === "prompts/get"
          ? `${method}:${String(parsed.params?.name ?? "")}`
          : method,
      );
      const ok = (result: Record<string, unknown>) =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "public",
              ...result,
            },
          }),
        );

      switch (method) {
        case "server/discover":
          return ok({
            supportedVersions: [MODERN],
            capabilities: { tools: {}, prompts: {} },
          });
        case "tools/list":
          return ok({
            tools: [
              {
                name: "weather",
                inputSchema: { type: "object", properties: {} },
                outputSchema: OUTPUT_SCHEMA,
              },
              {
                name: "city",
                inputSchema: { type: "object", properties: {} },
                outputSchema: DRAFT_07_OUTPUT_SCHEMA,
              },
              { name: "plain", inputSchema: { type: "object", properties: {} } },
            ],
          });
        case "prompts/list":
          return ok({ prompts: [{ name: "welcome" }] });
        case "prompts/get":
          return ok({
            messages: [
              { role: "user", content: { type: "text", text: "welcome" } },
            ],
          });
        case "tools/call": {
          const name = parsed.params?.name;
          if (name === "weather") {
            return ok(
              options.weatherResult ?? {
                content: [{ type: "text", text: "12" }],
                structuredContent: { temperature: 12 },
              },
            );
          }
          if (name === "city") {
            return ok(
              options.cityResult ?? {
                content: [{ type: "text", text: "Lisbon" }],
                structuredContent: { city: "Lisbon" },
              },
            );
          }
          return ok({ content: [{ type: "text", text: "ok" }] });
        }
        default:
          return res
            .writeHead(404, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
              }),
            );
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        // `close` only stops new connections; the conformance client leaves
        // keep-alive sockets open, and without this the promise never settles.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}/mcp`;
}

async function run(
  serverOptions: FixtureServerOptions,
  fixtures: MCPConformanceFixtures | undefined,
  checkIds: MCPCheckId[],
) {
  const url = await serveFixtureServer(serverOptions);
  return await new MCPConformanceTest({
    serverUrl: url,
    protocolVersion: MODERN,
    checkTimeout: 5_000,
    checkIds,
    ...(fixtures ? { fixtures } : {}),
  }).run();
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`check ${id} not found`);
  return found;
}

const ID: MCPCheckId = "modern-tool-output-schema-conformant";

describe("nothing is executed without a fixture", () => {
  it("skips, and never calls a tool, when no fixtures are configured", async () => {
    const calls: string[] = [];
    const result = await run({ calls }, undefined, [ID]);
    const check = byId(result.checks, ID);
    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    // The load-bearing assertion of this whole feature: a default run does not
    // execute anything on the server under test.
    expect(calls.filter((call) => call.startsWith("tools/call"))).toEqual([]);
    // And the skip says what it needs, rather than reading as a server defect.
    expect(check.error?.message).toContain("fixtures.toolCalls");
  });
});

describe("modern-tool-output-schema-conformant", () => {
  it("passes structuredContent that conforms to the declared schema", async () => {
    const check = byId(
      (await run({}, { toolCalls: [{ toolName: "weather" }] }, [ID])).checks,
      ID,
    );
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails structuredContent that violates the declared schema", async () => {
    const check = byId(
      (
        await run(
          {
            weatherResult: {
              content: [{ type: "text", text: "hot" }],
              structuredContent: { temperature: "hot" },
            },
          },
          { toolCalls: [{ toolName: "weather" }] },
          [ID],
        )
      ).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("does not conform");
  });

  it("fails a declared outputSchema with no structuredContent at all", async () => {
    const check = byId(
      (
        await run(
          { weatherResult: { content: [{ type: "text", text: "12" }] } },
          { toolCalls: [{ toolName: "weather" }] },
          [ID],
        )
      ).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("no structuredContent");
  });

  it("judges a draft-07 output schema under draft-07", async () => {
    // `zod-to-json-schema` stamps draft-07 by default, so rejecting it as
    // "not 2020-12" would fail a large share of real servers.
    const check = byId(
      (await run({}, { toolCalls: [{ toolName: "city" }] }, [ID])).checks,
      ID,
    );
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("does not bind the schema to an isError result", async () => {
    // A tool reporting its own failure is a normal outcome the server is
    // entitled to return, and the spec's example of one carries no
    // structuredContent. Grading it would fail servers for correctly saying
    // the weather API was down — so it is NOT a violation. It is also not
    // evidence the requirement holds, so the run reports a skip rather than a
    // pass it did not earn.
    const check = byId(
      (
        await run(
          {
            weatherResult: {
              content: [{ type: "text", text: "API down" }],
              isError: true,
            },
          },
          { toolCalls: [{ toolName: "weather" }] },
          [ID],
        )
      ).checks,
      ID,
    );
    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toContain("isError");
  });

  it("skips rather than passes when no fixture declares an outputSchema", async () => {
    const check = byId(
      (await run({}, { toolCalls: [{ toolName: "plain" }] }, [ID])).checks,
      ID,
    );
    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toContain("never exercised");
  });
});

describe("fixtures widen the wire-schema coverage", () => {
  const WIRE: MCPCheckId = "wire-schema-valid";

  it("grades CallToolResult and GetPromptResult only once fixtures supply them", async () => {
    const withoutFixtures = byId(
      (await run({}, undefined, [WIRE, ID])).checks,
      WIRE,
    );
    const withFixtures = byId(
      (
        await run(
          {},
          {
            toolCalls: [{ toolName: "weather" }],
            promptGets: [{ promptName: "welcome" }],
          },
          [WIRE, ID],
        )
      ).checks,
      WIRE,
    );

    expect(withoutFixtures.status).toBe("passed");
    expect(withFixtures.status).toBe("passed");
    // The point of the feature: strictly more of the wire got graded.
    expect(Number(withFixtures.details?.methodCorrelated)).toBeGreaterThan(
      Number(withoutFixtures.details?.methodCorrelated),
    );
  });

  it("catches a malformed prompts/get result the unfixtured run never sees", async () => {
    // A server whose `prompts/get` result omits the required `messages`. The
    // unfixtured run never calls `prompts/get` at all, so only the fixture
    // lane can reach this defect.
    const broken = http.createServer((req, res) => {
      void (async () => {
        const parsed = await readJsonRpcBody(req, res);
        if (!parsed) return;
        const id = requestId(parsed);
        const base = {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "public",
        };
        // Everything except `prompts/get` is well-formed, so the failure the
        // test asserts is unambiguously the one it introduced. The readiness
        // lane probes `tools/list` and `resources/read` on every modern run,
        // and those frames reach the same wire record.
        const result =
          parsed.method === "server/discover"
            ? {
                ...base,
                supportedVersions: [MODERN],
                capabilities: { prompts: {}, tools: {}, resources: {} },
              }
            : parsed.method === "prompts/get"
              ? { ...base, description: "no messages member at all" }
              : parsed.method === "tools/list"
                ? { ...base, tools: [] }
                : parsed.method === "resources/read"
                  ? { ...base, contents: [] }
                  : parsed.method === "resources/list"
                    ? { ...base, resources: [] }
                    : { ...base, prompts: [] };
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      })();
    });
    await new Promise<void>((resolve) =>
      broken.listen(0, "127.0.0.1", resolve),
    );
    const { port } = broken.address() as AddressInfo;
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          broken.closeAllConnections();
          broken.close(() => resolve());
        }),
    );
    const result = await new MCPConformanceTest({
      serverUrl: `http://127.0.0.1:${port}/mcp`,
      protocolVersion: MODERN,
      checkTimeout: 5_000,
      checkIds: [WIRE],
      fixtures: { promptGets: [{ promptName: "welcome" }] },
    }).run();

    const check = byId(result.checks, WIRE);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("GetPromptResult");
  });
});

/**
 * The harness must never be the source of a malformed request.
 *
 * `GetPromptRequest.params.arguments` is `Record<string, string>` in every
 * revision's schema. If a bad value reaches the wire, `wire-schema-valid`
 * reports a violation against the SERVER for a request WE built — the single
 * most damaging thing a conformance suite can do.
 */
describe("prompt fixture arguments are validated before they reach the wire", () => {
  const normalize = (args: unknown) =>
    normalizeMCPConformanceConfig({
      serverUrl: "https://example.test/mcp",
      fixtures: {
        promptGets: [{ promptName: "welcome", arguments: args as never }],
      },
    });

  it("accepts an object of string values, and an absent arguments key", () => {
    expect(
      normalize({ name: "Ada" }).fixtures?.promptGets?.[0].arguments,
    ).toEqual({ name: "Ada" });
    expect(normalize(undefined).fixtures?.promptGets?.[0].arguments).toBeUndefined();
    // An empty object is a legitimate "no arguments"; only the container shape
    // is being judged here.
    expect(normalize({}).fixtures?.promptGets?.[0].arguments).toEqual({});
  });

  // The container cases are the ones a values-only loop lets through, because
  // `Object.entries` COERCES rather than throwing: a string spreads into
  // index/character pairs whose values are all strings, and a number or boolean
  // yields no entries at all. Each of these once passed validation and was
  // forwarded verbatim as `params.arguments`.
  for (const [label, value] of [
    ["a string", "Ada"],
    ["a number", 42],
    ["a boolean", false],
    ["null", null],
    ["an array", ["Ada"]],
    ["an empty array", []],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => normalize(value)).toThrow(/arguments must be an object/);
    });
  }

  it("rejects a non-string value inside a well-shaped object, naming the key", () => {
    expect(() => normalize({ count: 2 })).toThrow(
      /arguments\.count must be a string/,
    );
  });
});

describe("tool fixture arguments share the container rule", () => {
  const normalize = (args: unknown) =>
    normalizeMCPConformanceConfig({
      serverUrl: "https://example.test/mcp",
      fixtures: {
        toolCalls: [{ toolName: "echo", arguments: args as never }],
      },
    });

  for (const [label, value] of [
    ["a string", "Ada"],
    ["a number", 42],
    ["a boolean", false],
    ["null", null],
    ["an array", ["Ada"]],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(() => normalize(value)).toThrow(/arguments must be an object/);
    });
  }

  it("preserves arbitrary JSON VALUES, unlike prompt arguments", () => {
    // `CallToolRequestParams.arguments` is `{"type":"object","additionalProperties":{}}`
    // — the container is constrained, the values are not. Applying the prompt
    // rule here would reject legitimate structured tool input.
    const args = { count: 2, nested: { a: [1, 2] }, flag: true, none: null };
    expect(normalize(args).fixtures?.toolCalls?.[0].arguments).toEqual(args);
  });
});

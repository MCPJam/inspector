/**
 * Tool Output Schema Honored on the 2025 revisions.
 *
 * "If an output schema is provided: Servers MUST provide structured results
 * that conform to this schema" is in 2025-06-18 (server/tools.mdx:312-314) and
 * 2025-11-25 (:338-340). The check ran on 2026-07-28 only, so on those two
 * revisions it said "not applicable" and a result that broke its own schema
 * was never caught.
 *
 * These drive the check with a scripted 2025 server and pin what it sends
 * (a session of its own, opened and closed), and what it says for each kind of
 * answer. What makes a result conform is graded by the same code as on
 * 2026-07-28, which `tool-output-schema.unit.test.ts` covers.
 */

import { describe, expect, it } from "vitest";
import {
  FIRST_OUTPUT_SCHEMA_VERSION,
  hasOutputSchemaRule,
} from "../../src/mcp-conformance/checks/legacy-tool-output-schema.js";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  CHECK_ERAS,
  CHECK_FIRST_PROTOCOL_VERSION,
  MCP_CHECK_IDS,
  PROTOCOL_VERSION_ERAS,
  checkRunsOnVersion,
  type MCPCheckId,
} from "../../src/mcp-conformance/types.js";
import { MCP_PROTOCOL_VERSIONS } from "../../src/mcp-client-manager/mcp-protocol-version.js";

const ID: MCPCheckId = "modern-tool-output-schema-conformant";
const SERVER_URL = "http://127.0.0.1:9/mcp";
const SESSION = "session-1";

const GREETING_SCHEMA = {
  type: "object",
  properties: { greeting: { type: "string" } },
  required: ["greeting"],
};

interface ScriptedTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** The `tools/call` result. */
  result?: Record<string, unknown>;
  /** Answer `tools/call` with this JSON-RPC error instead. */
  error?: { code: number; message: string };
}

interface ServerOptions {
  tools?: ScriptedTool[];
  /** Tools per `tools/list` page. Default: all on one page. */
  pageSize?: number;
  /** Answer `tools/list` with a body that has no `tools` array. */
  malformedListing?: boolean;
  /** Capabilities in the `initialize` answer. Default: `{ tools: {} }`. */
  capabilities?: Record<string, unknown>;
  /** Answer `initialize` with this status and no result. */
  initializeStatus?: number;
  /** Answer `initialize` with this protocol version. */
  answeredVersion?: string;
  /** Answer `initialize` with a 200 that carries no result. */
  emptyInitialize?: boolean;
  /** A server with no sessions. */
  stateless?: boolean;
  /** Frame results as one SSE event. */
  sse?: boolean;
  /** The request for this method never completes: the fetch rejects. */
  dropped?: string;
}

interface Seen {
  method: string;
  tool?: string;
  sessionId: string | null;
  version: string | null;
}

const hello = (overrides: Partial<ScriptedTool> = {}): ScriptedTool => ({
  name: "hello-typed",
  outputSchema: GREETING_SCHEMA,
  result: {
    content: [{ type: "text", text: "Hello" }],
    structuredContent: { greeting: "Hello" },
  },
  ...overrides,
});

function scriptedServer(options: ServerOptions = {}) {
  const tools = options.tools ?? [hello()];
  const seen: Seen[] = [];
  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const at = {
      sessionId: headers.get("mcp-session-id"),
      version: headers.get("mcp-protocol-version"),
    };
    if (init?.method === "DELETE") {
      seen.push({ method: "DELETE", ...at });
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; cursor?: string; protocolVersion?: string };
    };
    seen.push({
      method: body.method,
      ...(body.params?.name ? { tool: body.params.name } : {}),
      ...at,
    });
    if (body.method === options.dropped) {
      throw new DOMException("This operation was aborted", "AbortError");
    }
    const answer = (
      payload: Record<string, unknown>,
      extra: Record<string, string> = {}
    ) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload });
      return options.sse && body.method !== "initialize"
        ? new Response(`event: message\ndata: ${text}\n\n`, {
            headers: { "content-type": "text/event-stream", ...extra },
          })
        : new Response(text, {
            headers: { "content-type": "application/json", ...extra },
          });
    };

    switch (body.method) {
      case "initialize":
        if (options.initializeStatus) {
          return new Response("upstream is down", {
            status: options.initializeStatus,
          });
        }
        if (options.emptyInitialize) return answer({});
        return answer(
          {
            result: {
              protocolVersion:
                options.answeredVersion ?? body.params?.protocolVersion,
              capabilities: options.capabilities ?? { tools: {} },
              serverInfo: { name: "scripted", version: "1.0.0" },
            },
          },
          options.stateless ? {} : { "mcp-session-id": SESSION }
        );
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list": {
        if (options.malformedListing) return answer({ result: {} });
        const size = options.pageSize ?? tools.length;
        const start = Number(body.params?.cursor ?? 0);
        const page = tools.slice(start, start + size);
        const next = start + size;
        return answer({
          result: {
            tools: page.map((tool) => ({
              name: tool.name,
              inputSchema: tool.inputSchema ?? {
                type: "object",
                properties: {},
              },
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            })),
            ...(next < tools.length ? { nextCursor: String(next) } : {}),
          },
        });
      }
      case "tools/call": {
        const called = tools.find((tool) => tool.name === body.params?.name);
        if (!called) {
          return answer({ error: { code: -32602, message: "Unknown tool" } });
        }
        return called.error
          ? answer({ error: called.error })
          : answer({ result: called.result ?? { content: [] } });
      }
      default:
        return answer({ error: { code: -32601, message: "Method not found" } });
    }
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const FIXTURE = { toolCalls: [{ toolName: "hello-typed" }] };

async function grade(
  server: ReturnType<typeof scriptedServer>,
  options: {
    protocolVersion?: string;
    fixtures?: { toolCalls: Array<Record<string, unknown>> };
    surfaceTools?: Array<Record<string, unknown>>;
  } = {}
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: SERVER_URL,
    protocolVersion: options.protocolVersion ?? "2025-11-25",
    fetchFn: server.fetchFn,
    ...(options.fixtures ? { fixtures: options.fixtures } : {}),
  } as never);
  const results = await runModernChecks(
    {
      config,
      serverUrl: SERVER_URL,
      fetchFn: config.fetchFn,
      ...(options.surfaceTools
        ? { surface: { tools: options.surfaceTools } as never }
        : {}),
    },
    new Set([ID])
  );
  expect(results).toHaveLength(1);
  return results[0]!;
}

const wire = (server: ReturnType<typeof scriptedServer>) =>
  server.seen.map((entry) =>
    entry.tool ? `${entry.method} ${entry.tool}` : entry.method
  );

const HANDSHAKE = ["initialize", "notifications/initialized"];

describe("which revisions have the rule", () => {
  it("applies the check to both eras", () => {
    expect([...CHECK_ERAS[ID]].sort()).toEqual(["legacy", "modern"]);
  });

  it("starts with 2025-06-18", () => {
    expect(FIRST_OUTPUT_SCHEMA_VERSION).toBe("2025-06-18");
    expect(hasOutputSchemaRule("2025-03-26")).toBe(false);
    expect(hasOutputSchemaRule("2025-06-18")).toBe(true);
    expect(hasOutputSchemaRule("2025-11-25")).toBe(true);
  });

  it("says per version whether the check has anything to grade", () => {
    expect(CHECK_FIRST_PROTOCOL_VERSION).toEqual({ [ID]: "2025-06-18" });
    expect(
      MCP_PROTOCOL_VERSIONS.map((version) => [
        version,
        checkRunsOnVersion(ID, version),
      ]),
    ).toEqual([
      ["2025-03-26", false],
      ["2025-06-18", true],
      ["2025-11-25", true],
      ["2026-07-28", true],
    ]);
  });

  it("follows the era alone for every check that names no first version", () => {
    for (const id of MCP_CHECK_IDS) {
      if (id === ID) continue;
      for (const version of MCP_PROTOCOL_VERSIONS) {
        expect([id, version, checkRunsOnVersion(id, version)]).toEqual([
          id,
          version,
          (CHECK_ERAS[id] as readonly string[]).includes(
            PROTOCOL_VERSION_ERAS[version],
          ),
        ]);
      }
    }
  });

  it("is not applicable on 2025-03-26, and sends nothing", async () => {
    const server = scriptedServer();
    const result = await grade(server, {
      protocolVersion: "2025-03-26",
      fixtures: FIXTURE,
    });

    expect(result.skipReason).toBe("not-applicable");
    expect(result.error?.message).toBe(
      "2025-03-26 has no outputSchema: tools can declare one from 2025-06-18 on"
    );
    expect(server.seen).toEqual([]);
  });
});

describe.each(["2025-06-18", "2025-11-25"])("on %s", (protocolVersion) => {
  it("passes a result that conforms, on a session it opens and closes", async () => {
    const server = scriptedServer();
    const result = await grade(server, { protocolVersion, fixtures: FIXTURE });

    expect(result.status).toBe("passed");
    expect(wire(server)).toEqual([
      ...HANDSHAKE,
      "tools/list",
      "tools/call hello-typed",
      "DELETE",
    ]);
    // Everything after initialize is on the session, with the version header.
    for (const request of server.seen.slice(1)) {
      expect([request.method, request.sessionId, request.version]).toEqual([
        request.method,
        SESSION,
        protocolVersion,
      ]);
    }
  });

  it("fails a result that breaks the schema", async () => {
    const server = scriptedServer({
      tools: [hello({ result: { structuredContent: { greeting: 42 } } })],
    });
    const result = await grade(server, { protocolVersion, fixtures: FIXTURE });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(
      "hello-typed structuredContent does not conform to its declared outputSchema"
    );
    // The session is closed after a failure too.
    expect(wire(server).at(-1)).toBe("DELETE");
  });

  it("fails a result with no structuredContent", async () => {
    const server = scriptedServer({
      tools: [hello({ result: { content: [{ type: "text", text: "Hi" }] } })],
    });
    const result = await grade(server, { protocolVersion, fixtures: FIXTURE });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain(
      "hello-typed declares an outputSchema but returned no structuredContent"
    );
  });
});

describe("2025-11-25: with no tool named", () => {
  it("could not run when a tool declares an outputSchema, and calls nothing", async () => {
    const server = scriptedServer();
    const result = await grade(server);

    expect(result.skipReason).toBe("could-not-run");
    expect(result.error?.message).toMatch(
      /^1 tool\(s\) declare an outputSchema, but no tools\/call fixture was configured:/
    );
    expect(result.details).toMatchObject({
      declaredOutputSchemas: ["hello-typed"],
      missingInput: "toolCallProbe",
    });
    expect(wire(server)).toEqual([...HANDSHAKE, "tools/list", "DELETE"]);
  });

  it("is not applicable when no tool declares one", async () => {
    const server = scriptedServer({ tools: [{ name: "plain" }] });
    const result = await grade(server);

    expect(result.skipReason).toBe("not-applicable");
    expect(result.error?.message).toMatch(/No tool declares an outputSchema/);
  });

  it("reads every page before saying no tool declares one", async () => {
    const server = scriptedServer({
      tools: [{ name: "plain" }, { name: "also-plain" }, hello()],
      pageSize: 1,
    });
    const result = await grade(server);

    // The schema is on the third page.
    expect(result.skipReason).toBe("could-not-run");
    expect(result.details).toMatchObject({
      declaredOutputSchemas: ["hello-typed"],
    });
    expect(wire(server).filter((method) => method === "tools/list")).toHaveLength(3);
  });

  it("could not run when the listing cannot be read to the end", async () => {
    const server = scriptedServer({ malformedListing: true });
    const result = await grade(server);

    expect(result.skipReason).toBe("could-not-run");
    expect(result.error?.message).toMatch(/tools\/list walk did not finish/);
  });
});

describe("2025-11-25: answers that leave nothing to grade", () => {
  it("is not applicable when the server has no tools capability", async () => {
    const server = scriptedServer({ capabilities: {} });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("not-applicable");
    expect(result.error?.message).toBe(
      "Server does not advertise the tools capability"
    );
    // The session it opened to find out is still closed.
    expect(wire(server)).toEqual([...HANDSHAKE, "DELETE"]);
  });

  it("does not grade a result the tool marked isError", async () => {
    const server = scriptedServer({
      tools: [hello({ result: { isError: true, content: [] } })],
    });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("could-not-run");
    expect(result.details?.graded).toEqual([
      {
        tool: "hello-typed",
        outcome: "tool reported isError: true; output schema does not bind",
        schemaBound: false,
      },
    ]);
  });

  it("asks for another tool when the named one declares no outputSchema", async () => {
    const server = scriptedServer({
      tools: [{ name: "hello-typed", result: { content: [] } }],
    });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("could-not-run");
    expect(result.details).toMatchObject({ missingInput: "toolCallProbe" });
  });

  it("points at the arguments when the tool's own inputSchema rejects them", async () => {
    const server = scriptedServer({
      tools: [
        hello({
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          error: { code: -32602, message: "name is required" },
        }),
      ],
    });
    const result = await grade(server, {
      fixtures: FIXTURE,
      surfaceTools: [
        {
          name: "hello-typed",
          inputSchema: { type: "object", properties: {} },
          outputSchema: GREETING_SCHEMA,
        },
      ],
    });

    // The client session allowed empty arguments, but the probe session did not.
    expect(result.skipReason).toBe("could-not-run");
    expect(result.details).toMatchObject({
      missingInput: "toolCallProbe",
      unexercised: [expect.stringContaining("JSON-RPC -32602")],
    });
  });
});

describe("2025-11-25: a handshake that does not end in a session", () => {
  it("could not run when initialize is refused, and sends nothing more", async () => {
    const server = scriptedServer({ initializeStatus: 503 });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("could-not-run");
    expect(result.error?.message).toMatch(/HTTP 503/);
    expect(wire(server)).toEqual(["initialize"]);
  });

  it("could not run when the server answers another version, and only closes the session", async () => {
    const server = scriptedServer({ answeredVersion: "2025-06-18" });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("could-not-run");
    expect(wire(server)).toEqual(["initialize", "DELETE"]);
  });

  it("could not run when the initialize answer cannot be read", async () => {
    const server = scriptedServer({ emptyInitialize: true });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.skipReason).toBe("could-not-run");
    expect(result.error?.message).toMatch(
      /initialize did not return a usable result \(HTTP 200\)/
    );
    expect(wire(server)).not.toContain("tools/list");
  });
});

describe("2025-11-25: a request that does not complete", () => {
  it.each(["initialize", "tools/list", "tools/call"])(
    "could not run when %s times out, and does not fail the server",
    async (dropped) => {
      const server = scriptedServer({ dropped });
      const result = await grade(server, { fixtures: FIXTURE });

      expect([result.status, result.skipReason]).toEqual([
        "skipped",
        "could-not-run",
      ]);
      expect(result.error?.message).toBe(
        "A request this check sent did not complete (This operation was aborted), so no tool result could be checked against its outputSchema"
      );
    }
  );

  it("still closes the session it had opened", async () => {
    const server = scriptedServer({ dropped: "tools/call" });
    await grade(server, { fixtures: FIXTURE });

    expect(wire(server).at(-1)).toBe("DELETE");
  });

  it("stops without a verdict when the run is cancelled", async () => {
    const controller = new AbortController();
    const server = scriptedServer();
    const cancelling = (async (input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "tools/list") {
        controller.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return server.fetchFn(input as never, init);
    }) as unknown as typeof fetch;
    const config = normalizeMCPConformanceConfig({
      serverUrl: SERVER_URL,
      protocolVersion: "2025-11-25",
      fetchFn: cancelling,
      fixtures: FIXTURE,
      signal: controller.signal,
    } as never);

    await expect(
      runModernChecks(
        { config, serverUrl: SERVER_URL, fetchFn: config.fetchFn },
        new Set([ID])
      )
    ).rejects.toThrow();
  });
});

describe("2025-11-25: how the server is addressed", () => {
  it("reads results framed as SSE", async () => {
    const server = scriptedServer({ sse: true });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.status).toBe("passed");
  });

  it("sends no session id and no DELETE to a server without sessions", async () => {
    const server = scriptedServer({ stateless: true });
    const result = await grade(server, { fixtures: FIXTURE });

    expect(result.status).toBe("passed");
    expect(wire(server)).toEqual([
      ...HANDSHAKE,
      "tools/list",
      "tools/call hello-typed",
    ]);
    expect(server.seen.every((request) => request.sessionId === null)).toBe(true);
  });

  it("grades against the probe session's output schema when the client listing differs", async () => {
    const server = scriptedServer();
    const result = await grade(server, {
      fixtures: FIXTURE,
      surfaceTools: [
        {
          name: "hello-typed",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { greeting: { type: "number" } },
            required: ["greeting"],
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(wire(server)).toEqual([
      ...HANDSHAKE,
      "tools/list",
      "tools/call hello-typed",
      "DELETE",
    ]);
  });

  it("calls every tool named, and fails for the one that breaks its schema", async () => {
    const server = scriptedServer({
      tools: [
        hello(),
        hello({
          name: "broken",
          result: { structuredContent: { greeting: null } },
        }),
      ],
    });
    const result = await grade(server, {
      fixtures: { toolCalls: [{ toolName: "hello-typed" }, { toolName: "broken" }] },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("broken structuredContent");
    expect(result.error?.message).not.toContain("hello-typed structuredContent");
    expect(wire(server)).toEqual([
      ...HANDSHAKE,
      "tools/list",
      "tools/call hello-typed",
      "tools/call broken",
      "DELETE",
    ]);
  });
});

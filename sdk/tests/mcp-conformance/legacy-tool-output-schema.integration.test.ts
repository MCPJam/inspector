/**
 * Tool Output Schema Honored against real 2025 listeners.
 *
 * "If an output schema is provided: Servers MUST provide structured results
 * that conform to this schema" (2025-06-18 server/tools.mdx:312-314,
 * 2025-11-25 :338-340). The check used to say "not applicable" on both.
 *
 * The whole runner is driven over a socket, so this covers what the unit file
 * cannot: the real `fetch`, the check picked on its own and next to a check
 * that runs through the MCP client, and the run's verdict. Each listener
 * records every request it was sent.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const CHECK: MCPCheckId = "modern-tool-output-schema-conformant";
const TOOL = "hello-typed";

interface Fixture {
  url: string;
  /** `METHOD` for a request with no body, else the JSON-RPC method. */
  requests: string[];
  /** Session ids the client sent on `tools/call`. */
  callSessions: Array<string | undefined>;
  close: () => Promise<void>;
}

/**
 * A stateful 2025 server with one typed tool. `structuredContent` is what the
 * tool returns, so a test picks a result that keeps or breaks the schema.
 */
async function serve(options: {
  version: "2025-03-26" | "2025-06-18" | "2025-11-25";
  /** `undefined` leaves `structuredContent` out of the result. */
  structuredContent?: unknown;
  /** Declare no `outputSchema` on the tool. */
  noOutputSchema?: boolean;
  /** Answer results as one SSE event. */
  sse?: boolean;
}): Promise<Fixture> {
  const requests: string[] = [];
  const callSessions: Array<string | undefined> = [];
  let sessions = 0;
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        requests.push(String(req.method));
        // GET: no standalone stream. DELETE: the session is ended.
        res.writeHead(req.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const message = JSON.parse(text) as {
        id?: unknown;
        method: string;
        params?: { name?: string };
      };
      requests.push(message.method);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (
        payload: Record<string, unknown>,
        headers: Record<string, string> = {},
      ) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload });
        if (options.sse && message.method !== "initialize") {
          res.writeHead(200, { "content-type": "text/event-stream", ...headers });
          res.end(`event: message\ndata: ${body}\n\n`);
          return;
        }
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(body);
      };

      switch (message.method) {
        case "initialize":
          sessions += 1;
          reply(
            {
              result: {
                protocolVersion: options.version,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "typed-tool-fixture", version: "1.0.0" },
              },
            },
            { "mcp-session-id": `session-${sessions}` },
          );
          return;
        case "tools/list":
          reply({
            result: {
              tools: [
                {
                  name: TOOL,
                  description: "Says hello, with a typed result.",
                  inputSchema: { type: "object", properties: {} },
                  ...(options.noOutputSchema
                    ? {}
                    : {
                        outputSchema: {
                          type: "object",
                          properties: { greeting: { type: "string" } },
                          required: ["greeting"],
                        },
                      }),
                },
              ],
            },
          });
          return;
        case "tools/call": {
          const session = req.headers["mcp-session-id"];
          callSessions.push(Array.isArray(session) ? session[0] : session);
          reply({
            result: {
              content: [{ type: "text", text: "Hello, world!" }],
              ...(options.structuredContent === undefined
                ? {}
                : { structuredContent: options.structuredContent }),
            },
          });
          return;
        }
        default:
          reply({ error: { code: -32601, message: "Method not found" } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    callSessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const opened: Fixture[] = [];

afterEach(async () => {
  for (const fixture of opened.splice(0)) await fixture.close();
});

async function run(
  fixture: Fixture,
  protocolVersion: string,
  options: { tool?: boolean; checkIds?: MCPCheckId[] } = {},
) {
  opened.push(fixture);
  const result = await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion,
    checkIds: options.checkIds ?? [CHECK],
    readinessIds: [],
    checkTimeout: 5_000,
    ...(options.tool === false
      ? {}
      : { fixtures: { toolCalls: [{ toolName: TOOL }] } }),
    __suppressTelemetry: true,
  } as never).run();
  const check = result.checks.find((entry) => entry.id === CHECK);
  if (!check) throw new Error(`no result for ${CHECK}`);
  return { result, check };
}

const GOOD = { greeting: "Hello, world!" };

describe.each(["2025-06-18", "2025-11-25"] as const)(
  "%s: a tool that declares an outputSchema",
  (version) => {
    it("passes when the result conforms", async () => {
      const fixture = await serve({ version, structuredContent: GOOD });
      const { result, check } = await run(fixture, version);

      expect(check.status).toBe("passed");
      expect(result.passed).toBe(true);
      // One session of its own: opened, used, closed.
      expect(fixture.requests).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
        "DELETE",
      ]);
      expect(fixture.callSessions).toEqual(["session-1"]);
    });

    it("fails when structuredContent breaks the schema", async () => {
      // The case the check never caught on this revision.
      const fixture = await serve({ version, structuredContent: { greeting: 42 } });
      const { result, check } = await run(fixture, version);

      expect(check.status).toBe("failed");
      expect(check.error?.message).toContain(
        `${TOOL} structuredContent does not conform to its declared outputSchema`,
      );
      // It is a scored check: the run fails with it.
      expect(result.passed).toBe(false);
    });

    it("fails when the result has no structuredContent", async () => {
      const fixture = await serve({ version });
      const { check } = await run(fixture, version);

      expect(check.status).toBe("failed");
      expect(check.error?.message).toContain("returned no structuredContent");
    });

    it("could not run with no tool named, and calls nothing", async () => {
      const fixture = await serve({ version, structuredContent: { greeting: 42 } });
      const { check } = await run(fixture, version, { tool: false });

      expect([check.status, check.skipReason]).toEqual([
        "skipped",
        "could-not-run",
      ]);
      expect(check.details).toMatchObject({ missingInput: "toolCallProbe" });
      expect(fixture.requests).not.toContain("tools/call");
    });
  },
);

describe("2025-11-25: where the rule has nothing to bind", () => {
  it("is not applicable when no tool declares an outputSchema", async () => {
    const fixture = await serve({ version: "2025-11-25", noOutputSchema: true });
    const { check } = await run(fixture, "2025-11-25", { tool: false });

    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "not-applicable",
    ]);
  });

  it("reads a result the server streams as SSE", async () => {
    const fixture = await serve({
      version: "2025-11-25",
      structuredContent: { greeting: 42 },
      sse: true,
    });
    const { check } = await run(fixture, "2025-11-25");

    expect(check.status).toBe("failed");
  });
});

describe("2025-03-26: before tools could declare an outputSchema", () => {
  it("is not applicable and sends nothing", async () => {
    const fixture = await serve({
      version: "2025-03-26",
      structuredContent: { greeting: 42 },
    });
    const { check } = await run(fixture, "2025-03-26");

    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "not-applicable",
    ]);
    expect(check.error?.message).toMatch(/2025-03-26 has no outputSchema/);
    expect(fixture.requests).toEqual([]);
  });
});

describe("2025-11-25: inside a run that also uses the MCP client", () => {
  it("grades the result next to Tools List", async () => {
    const fixture = await serve({
      version: "2025-11-25",
      structuredContent: { greeting: 42 },
    });
    const { result, check } = await run(fixture, "2025-11-25", {
      checkIds: ["tools-list", CHECK],
    });

    expect(result.checks.find((entry) => entry.id === "tools-list")?.status).toBe(
      "passed",
    );
    expect(check.status).toBe("failed");
    // The call went out on the check's own session, not on the client's.
    expect(fixture.callSessions).toHaveLength(1);
    expect(fixture.requests.filter((method) => method === "tools/call")).toHaveLength(1);
  });
});

/**
 * Named raw probes against a real HTTP server that refuses a bad `Mcp-Name`.
 *
 * The server reads the header off the socket, as any server would, and answers
 * HTTP 400 `-32020` when it is not plain visible ASCII or does not name the
 * target in the body. So a check that needs a named call can only run when the
 * probe encoded the name: a raw copy is refused, or cannot be sent at all.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody, requestId } from "../support/json-rpc-fixture.js";
import {
  headerMismatchError,
  mcpNameProblem,
  NAMES_THAT_NEED_ENCODING,
} from "../support/mcp-name-validation.js";
import {
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";

const MODERN = "2026-07-28" as const;
const ID: MCPCheckId = "modern-tool-output-schema-conformant";
/** Reads the first listed resource, so it needs a named `resources/read`. */
const READ_ID: MCPCheckId = "modern-cache-hint-coverage";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * A server whose one tool and one resource are both called `name`. `received`
 * logs each Mcp-Name.
 */
async function serveNamed(name: string, received: string[]) {
  const server = http.createServer((req, res) => {
    void (async () => {
      const parsed = await readJsonRpcBody(req, res);
      if (!parsed) return;
      const id = requestId(parsed);
      const send = (status: number, payload: Record<string, unknown>) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(payload));
      const ok = (result: Record<string, unknown>) =>
        send(200, {
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "public",
            ...result,
          },
        });

      const named = parsed.params?.name ?? parsed.params?.uri;
      if (typeof named === "string") {
        const header = req.headers["mcp-name"];
        const value = Array.isArray(header) ? header[0] : header;
        received.push(value ?? "");
        const problem = mcpNameProblem(value, named);
        if (problem) return send(400, headerMismatchError(id, problem));
      }

      switch (parsed.method) {
        case "server/discover":
          return ok({
            supportedVersions: [MODERN],
            capabilities: { tools: {}, resources: {} },
          });
        case "tools/list":
          return ok({
            tools: [
              {
                name,
                inputSchema: { type: "object", properties: {} },
                outputSchema: {
                  type: "object",
                  properties: { greeting: { type: "string" } },
                  required: ["greeting"],
                },
              },
            ],
          });
        case "tools/call":
          return ok({
            content: [{ type: "text", text: "hi" }],
            structuredContent: { greeting: "hi" },
          });
        case "resources/list":
          return ok({ resources: [{ uri: name, name: "greeting" }] });
        case "resources/templates/list":
          return ok({ resourceTemplates: [] });
        case "resources/read":
          return ok({ contents: [{ uri: named, text: "hi" }] });
        default:
          return send(404, {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${port}/mcp`;
}

describe.each(NAMES_THAT_NEED_ENCODING)(
  "a tool whose name %s",
  (_why, name) => {
    it("is called with an encoded Mcp-Name, and its check runs", async () => {
      const received: string[] = [];
      const serverUrl = await serveNamed(name, received);

      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion: MODERN,
        checkTimeout: 5_000,
        checkIds: [ID],
        fixtures: { toolCalls: [{ toolName: name }] },
      }).run();

      const check = result.checks.find((entry) => entry.id === ID);
      expect([check?.status, check?.error?.message]).toEqual([
        "passed",
        undefined,
      ]);
      // The server saw exactly one named call, and its header named the tool.
      expect(received).toHaveLength(1);
      expect(received[0]).toMatch(/^=\?base64\?/);
      expect(mcpNameProblem(received[0], name)).toBeUndefined();
    });
  }
);

describe("a tool with a plain ASCII name", () => {
  it("is called with the name as it is", async () => {
    const received: string[] = [];
    const serverUrl = await serveNamed("hello-world", received);

    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkTimeout: 5_000,
      checkIds: [ID],
      fixtures: { toolCalls: [{ toolName: "hello-world" }] },
    }).run();

    expect(result.checks.find((entry) => entry.id === ID)?.status).toBe(
      "passed"
    );
    expect(received).toEqual(["hello-world"]);
  });
});

describe.each(NAMES_THAT_NEED_ENCODING)(
  "a resource whose uri %s",
  (_why, uri) => {
    it("is read with an encoded Mcp-Name, and its check runs", async () => {
      const received: string[] = [];
      const serverUrl = await serveNamed(uri, received);

      const result = await new MCPConformanceTest({
        serverUrl,
        protocolVersion: MODERN,
        checkTimeout: 5_000,
        checkIds: [READ_ID],
      }).run();

      const check = result.checks.find((entry) => entry.id === READ_ID);
      expect([check?.status, check?.error?.message]).toEqual([
        "passed",
        undefined,
      ]);
      // The server saw exactly one named read, and its header named the uri.
      expect(received).toHaveLength(1);
      expect(received[0]).toMatch(/^=\?base64\?/);
      expect(mcpNameProblem(received[0], uri)).toBeUndefined();
    });
  }
);

describe("a resource with a plain ASCII uri", () => {
  it("is read with the uri as it is", async () => {
    const received: string[] = [];
    const serverUrl = await serveNamed("hello://greeting", received);

    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkTimeout: 5_000,
      checkIds: [READ_ID],
    }).run();

    expect(result.checks.find((entry) => entry.id === READ_ID)?.status).toBe(
      "passed"
    );
    expect(received).toEqual(["hello://greeting"]);
  });
});

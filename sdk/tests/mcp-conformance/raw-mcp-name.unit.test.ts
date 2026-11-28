/**
 * The `Mcp-Name` header on the hand-built 2026-07-28 probes.
 *
 * "If the `Mcp-Name` source value cannot be safely represented as a plain
 * ASCII header value, clients MUST encode it using the Base64 sentinel
 * format", and "clients MUST also Base64-encode any plain-ASCII value that
 * matches the sentinel pattern". A probe that copies the name into the header
 * as it is gets refused by the server, and the check behind it never runs.
 *
 * The scripted server here refuses a bad `Mcp-Name` the way a conforming one
 * does, so a check only passes when the header was sent correctly.
 */

import { describe, expect, it } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import { modernHeaders } from "../../src/mcp-conformance/raw-http.js";
import type {
  MCPCheckId,
  MCPServerSurfaceSnapshot,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  headerMismatchError,
  mcpNameProblem,
  NAMES_THAT_NEED_ENCODING,
} from "../support/mcp-name-validation.js";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { greeting: { type: "string" } },
  required: ["greeting"],
};

function headers(name?: string) {
  return modernHeaders({
    protocolVersion: "2026-07-28",
    method: "tools/call",
    name,
  });
}

describe("modernHeaders writes Mcp-Name the way a client must", () => {
  it.each([
    ["a plain tool name", "hello-world"],
    ["a plain resource URI", "hello://greeting"],
    ["a name with a space inside", "hello world"],
  ])("sends %s as it is", (_label, name) => {
    expect(headers(name)["Mcp-Name"]).toBe(name);
  });

  it.each([
    ...NAMES_THAT_NEED_ENCODING,
    // HTTP drops whitespace around a field value, so it has to be wrapped.
    ["has a space at the end", "hello "] as [string, string],
  ])("encodes a name that %s", (_why, name) => {
    const sent = headers(name)["Mcp-Name"];
    expect(sent).toMatch(/^=\?base64\?[A-Za-z0-9+/]*=*\?=$/);
    // Whatever was sent, a server reading it gets the name back.
    expect(mcpNameProblem(sent, name)).toBeUndefined();
  });

  it("sends no Mcp-Name for a request that names nothing", () => {
    expect(headers()).not.toHaveProperty("Mcp-Name");
  });
});

/** A 2026-07-28 server with one tool and one resource, both called `name`. */
function scriptedServer(name: string, sentNames: string[]): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const reply = (payload: Record<string, unknown>, status = 200) =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        }
      );
    const ok = (result: Record<string, unknown>) =>
      reply({
        result: {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "public",
          ...result,
        },
      });

    const named = body.params?.name ?? body.params?.uri;
    if (typeof named === "string") {
      const header = new Headers(init?.headers).get("mcp-name");
      sentNames.push(header ?? "");
      const problem = mcpNameProblem(header, named);
      if (problem) {
        return new Response(
          JSON.stringify(headerMismatchError(body.id, problem)),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    switch (body.method) {
      case "server/discover":
        return ok({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: {} },
        });
      case "tools/list":
        return ok({
          tools: [
            {
              name,
              inputSchema: { type: "object", properties: {} },
              outputSchema: OUTPUT_SCHEMA,
            },
          ],
        });
      case "tools/call":
        return ok({
          content: [{ type: "text", text: "hi" }],
          structuredContent: { greeting: "hi" },
        });
      case "resources/read":
        return ok({ contents: [{ uri: named, text: "hi" }] });
      default:
        return reply({ error: { code: -32601, message: "Method not found" } });
    }
  };
}

async function runCheck(
  id: MCPCheckId,
  name: string,
  sentNames: string[],
  surface?: MCPServerSurfaceSnapshot
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://names.example.test/mcp",
    protocolVersion: "2026-07-28",
    fixtures: { toolCalls: [{ toolName: name }] },
    fetchFn: scriptedServer(name, sentNames),
  });
  const results = await runModernChecks(
    { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn, surface },
    new Set([id])
  );
  return results[0];
}

describe.each(NAMES_THAT_NEED_ENCODING)(
  "a target whose name %s",
  (_why, name) => {
    it("is called with an Mcp-Name the server accepts, so the check runs", async () => {
      const sentNames: string[] = [];
      const check = await runCheck(
        "modern-tool-output-schema-conformant",
        name,
        sentNames
      );

      expect([check.status, check.error?.message]).toEqual([
        "passed",
        undefined,
      ]);
      expect(sentNames).toHaveLength(1);
      expect(sentNames[0]).not.toBe(name);
      expect(mcpNameProblem(sentNames[0], name)).toBeUndefined();
    });

    it("still gets a wrong Mcp-Name from the check that sends one on purpose", async () => {
      const sentNames: string[] = [];
      const check = await runCheck(
        "modern-name-header-mismatch",
        name,
        sentNames,
        {
          tools: [],
          toolNames: [],
          promptNames: [],
          resourceUris: [name],
          resourceTemplateUris: [],
          serverCapabilities: { resources: {} },
        }
      );

      // Encoding the wrong name keeps it wrong: the server must still refuse.
      expect(mcpNameProblem(sentNames.at(-1), name)).toBe(
        "Mcp-Name header does not match"
      );
      expect(check.status).toBe("passed");
    });
  }
);

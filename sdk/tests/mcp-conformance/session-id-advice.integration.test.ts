/**
 * A 2026-07-28 server that sends `Mcp-Session-Id`, against the whole runner.
 *
 * "An `Mcp-Session-Id` header on a request: ignore it, and do not mint or
 * echo session IDs" (2026-07-28 streamable-http.mdx:686-692) is a SHOULD.
 * Check 35 failed such a server, and with it the run.
 *
 * Real listeners and the real client, so this covers what the unit file
 * cannot: the client-backed checks on the same server, the run's verdict, and
 * the advice that takes the check's place.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/index.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";

const CHECK: MCPCheckId = "modern-no-session-id";
const ADVICE = "readiness-no-session-id";

interface Fixture {
  url: string;
  /** `Mcp-Session-Id` the client sent, per request. */
  sentSessionIds: Array<string | undefined>;
  close: () => Promise<void>;
}

/**
 * A 2026-07-28 server with `server/discover` and an empty `tools/list`.
 * `sessionId` goes on every answer; `undefined` sends none.
 */
async function serve(sessionId?: string): Promise<Fixture> {
  const sentSessionIds: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const sent = req.headers["mcp-session-id"];
      sentSessionIds.push(Array.isArray(sent) ? sent[0] : sent);
      const headers = {
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      };
      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(text || "{}");
      } catch {
        res.writeHead(400, headers).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const results: Record<string, unknown> = {
        "server/discover": {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "session-fixture",
              version: "1.0.0",
            },
          },
        },
        "tools/list": {
          resultType: "complete",
          tools: [],
          ttlMs: 0,
          cacheScope: "public",
        },
      };
      const result = results[String(message.method)];
      res.writeHead(result ? 200 : 404, headers);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id ?? null,
          ...(result
            ? { result }
            : { error: { code: -32601, message: "Method not found" } }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    sentSessionIds,
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

async function run(fixture: Fixture, checkIds: MCPCheckId[] = [CHECK]) {
  opened.push(fixture);
  return await new MCPConformanceTest({
    serverUrl: fixture.url,
    protocolVersion: "2026-07-28",
    checkIds,
    readinessIds: [ADVICE],
    checkTimeout: 5_000,
    __suppressTelemetry: true,
  } as never).run();
}

const byId = (result: Awaited<ReturnType<typeof run>>, id: MCPCheckId) => {
  const check = result.checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`no result for ${id}`);
  return check;
};

describe("2026-07-28: a server that sends a session id on every answer", () => {
  it("passes check 35, and the run with it", async () => {
    const result = await run(await serve("minted-123"));

    const check = byId(result, CHECK);
    expect(check.status, check.error?.message).toBe("passed");
    // Still visible in the report.
    expect(check.details?.sessionIds).toEqual([
      { status: 200, sessionId: "minted-123" },
    ]);
    expect(result.passed).toBe(true);
  });

  it("is told so as SHOULD advice", async () => {
    const result = await run(await serve("minted-123"));

    expect(result.readiness.filter((entry) => entry.id === ADVICE)).toEqual([
      expect.objectContaining({
        severity: "warning",
        specStrength: "SHOULD",
        message: expect.stringContaining('Mcp-Session-Id header ("minted-123")'),
      }),
    ]);
  });

  it("is served by the real client as usual, which never sends the id back", async () => {
    // Client-backed checks next to check 35: the header does not get in the
    // way of a 2026-07-28 client.
    const fixture = await serve("minted-123");
    const result = await run(fixture, [
      "modern-client-handshake",
      "tools-list",
      CHECK,
    ]);

    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["modern-client-handshake", "passed"],
      ["tools-list", "passed"],
      [CHECK, "passed"],
    ]);
    expect(fixture.sentSessionIds.every((id) => id === undefined)).toBe(true);
  });
});

describe("2026-07-28: a server that sends no session id", () => {
  it("passes check 35 and meets the advice", async () => {
    const result = await run(await serve());

    const check = byId(result, CHECK);
    expect(check.status).toBe("passed");
    expect(check.details).not.toHaveProperty("sessionIds");
    expect(result.readiness.filter((entry) => entry.id === ADVICE)).toEqual([]);
    expect(
      (result.passedAdvice ?? []).some((entry) => entry.id === ADVICE),
    ).toBe(true);
  });
});

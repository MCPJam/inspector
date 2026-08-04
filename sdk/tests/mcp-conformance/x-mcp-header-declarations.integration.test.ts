/**
 * `tools-x-mcp-header-declarations-valid` (SEP-2243) — the MUST that a
 * client-backed check CANNOT see.
 *
 * The official `Client.listTools()` implements the spec's other half: it
 * EXCLUDES tools whose `x-mcp-header` declarations are invalid before app code
 * ever sees the listing. So a check reading `manager.listTools()` is handed
 * only the survivors and passes against precisely the servers it exists to
 * catch. These tests drive a raw fixture that publishes offenders and prove the
 * check (and its readiness sibling) still find them.
 *
 * The fixture is a hand-written JSON-RPC responder rather than a real `Server`,
 * because the point is to publish a tool definition the SDK's own server-side
 * helpers would refuse to build.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";

const MODERN = "2026-07-28" as const;
const CHECK_ID = "tools-x-mcp-header-declarations-valid" as const;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type ToolDefinition = { name: string; inputSchema: unknown };

/** A raw modern responder that publishes exactly `tools`, in `pageSize` pages. */
async function serveTools(
  tools: ToolDefinition[],
  options: {
    pageSize?: number;
    capabilities?: Record<string, unknown>;
    /**
     * Serve a NON-repeating cursor cycle (`A → B → A → …`) and count the pages
     * served, so a walk that only compares against the previous cursor is
     * caught looping.
     */
    cycleCursors?: { pages: number };
  } = {},
): Promise<string> {
  const pageSize = options.pageSize ?? Math.max(tools.length, 1);
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let frame: any;
      try {
        frame = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }),
        );
      };
      if (frame.method === "server/discover") {
        reply({
          resultType: "server/discover",
          protocolVersions: [MODERN],
          capabilities: options.capabilities ?? { tools: {} },
          serverInfo: { name: "x-mcp-header-fixture", version: "1.0.0" },
        });
        return;
      }
      if (frame.method === "tools/list") {
        if (options.cycleCursors) {
          options.cycleCursors.pages += 1;
          const seen = frame.params?.cursor;
          reply({
            resultType: "tools/list",
            tools: [
              { name: `t-${seen ?? "start"}`, inputSchema: objectSchema({}) },
            ],
            nextCursor: seen === "A" ? "B" : "A",
          });
          return;
        }
        const page = Number(frame.params?.cursor ?? 0);
        const start = page * pageSize;
        const slice = tools.slice(start, start + pageSize);
        const hasMore = start + pageSize < tools.length;
        reply({
          resultType: "tools/list",
          tools: slice,
          ...(hasMore ? { nextCursor: String(page + 1) } : {}),
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: `no handler for ${frame.method}` },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(
    () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  );
  return `http://127.0.0.1:${port}/mcp`;
}

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

async function runCheck(
  serverUrl: string,
): Promise<{ check: MCPCheckResult; passed: boolean }> {
  const result = await new MCPConformanceTest({
    serverUrl,
    protocolVersion: MODERN,
    checkIds: [CHECK_ID],
    checkTimeout: 10_000,
  }).run();
  const check = result.checks.find((entry) => entry.id === CHECK_ID);
  if (!check) throw new Error(`${CHECK_ID} missing from results`);
  return { check, passed: result.passed };
}

describe("tools-x-mcp-header-declarations-valid", () => {
  it("passes a server with valid declarations, and counts them", async () => {
    const serverUrl = await serveTools([
      {
        name: "execute-sql",
        inputSchema: objectSchema({
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        }),
      },
      { name: "ping", inputSchema: objectSchema({}) },
    ]);

    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ toolCount: 2, declaringTools: 1 });
  });

  it("passes vacuously when no tool declares anything", async () => {
    const serverUrl = await serveTools([
      { name: "ping", inputSchema: objectSchema({}) },
    ]);
    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("passed");
    expect(check.details).toMatchObject({ declaringTools: 0 });
  });

  it("fails a declaration that is not statically reachable", async () => {
    const serverUrl = await serveTools([
      {
        name: "execute-sql",
        inputSchema: objectSchema({
          region: { oneOf: [{ type: "string", "x-mcp-header": "Region" }] },
        }),
      },
    ]);

    const { check, passed } = await runCheck(serverUrl);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toMatch(/statically reachable/);
    // The consequence, not just the verdict: the tool disappears entirely.
    expect(check.error?.message).toMatch(/exclude them from tools\/list/);
    expect(check.details).toMatchObject({
      violations: [
        { tool: "execute-sql", reason: expect.stringContaining("statically reachable") },
      ],
    });
    expect(passed).toBe(false);
  });

  it("fails a header name that is not an RFC 9110 token", async () => {
    const serverUrl = await serveTools([
      {
        name: "t",
        inputSchema: objectSchema({
          region: { type: "string", "x-mcp-header": "Bad Header" },
        }),
      },
    ]);
    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toMatch(/RFC 9110 token/);
  });

  it("fails a non-primitive declared property", async () => {
    const serverUrl = await serveTools([
      {
        name: "t",
        inputSchema: objectSchema({
          region: { type: "object", "x-mcp-header": "Region" },
        }),
      },
    ]);
    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toMatch(/primitive-typed properties/);
  });

  it("fails two declarations colliding case-insensitively", async () => {
    const serverUrl = await serveTools([
      {
        name: "t",
        inputSchema: objectSchema({
          a: { type: "string", "x-mcp-header": "Region" },
          b: { type: "string", "x-mcp-header": "region" },
        }),
      },
    ]);
    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toMatch(/case-insensitively unique/);
  });

  it("finds an offender on a LATER page — pagination is walked to the end", async () => {
    // An invisible tool on page 3 is exactly as invisible as one on page 1.
    const serverUrl = await serveTools(
      [
        { name: "a", inputSchema: objectSchema({}) },
        { name: "b", inputSchema: objectSchema({}) },
        {
          name: "offender",
          inputSchema: objectSchema({
            region: { type: "string", "x-mcp-header": "Bad Header" },
          }),
        },
      ],
      { pageSize: 1 },
    );

    const { check } = await runCheck(serverUrl);
    expect(check.status).toBe("failed");
    expect(check.details).toMatchObject({
      toolCount: 3,
      violations: [{ tool: "offender" }],
    });
  });

  it("detects a cursor CYCLE, not just a repeat, and refuses to pass", async () => {
    // `A → B → A` never repeats back-to-back, so a one-step comparison would
    // re-read the same pages to the cap and report the same tool many times.
    const cycling = { pages: 0 };
    const serverUrl = await serveTools([], { cycleCursors: cycling });

    const { check, passed } = await runCheck(serverUrl);
    // Not a pass: the walk never established that every tool was read.
    expect(check.status).toBe("skipped");
    expect(check.error?.message).toMatch(/reissued a cursor/);
    // Not a pass, and now the verdict says so: the walk never established that
    // every tool was read, so the obligation is untested and the run is
    // `incomplete` rather than green.
    expect(check.skipReason).toBe("could-not-run");
    expect(passed).toBe(false);
    // Terminated at the cycle, not at the 64-page cap. The counter is shared
    // by every tools/list this run makes — the check's walk, the readiness
    // walk, and the cache-TTL probe — so the bound is a handful of pages
    // rather than 3. An undetected cycle would be 64 PER walk.
    expect(cycling.pages).toBeLessThan(10);
  });

  it("skips a server that advertises no tools capability", async () => {
    // A server without tools is not non-conformant — a skip, never a failure.
    const serverUrl = await serveTools([], { capabilities: {} });
    const { check, passed } = await runCheck(serverUrl);
    expect(check.status).toBe("skipped");
    expect(check.error?.message).toMatch(/does not advertise the tools capability/);
    expect(passed).toBe(true);
  });

  it("era-skips on a legacy run", async () => {
    const serverUrl = await serveTools([
      {
        name: "t",
        inputSchema: objectSchema({
          region: { oneOf: [{ type: "string", "x-mcp-header": "Region" }] },
        }),
      },
    ]);
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: "2025-11-25",
      checkIds: [CHECK_ID],
      checkTimeout: 10_000,
    }).run();
    const check = result.checks.find((entry) => entry.id === CHECK_ID);
    expect(check?.status).toBe("skipped");
    expect(check?.error?.message).toMatch(/Not applicable to the legacy era/);
  });
});

describe("readiness-x-mcp-header-declarations", () => {
  it("explains the impact an operator actually feels", async () => {
    const serverUrl = await serveTools([
      {
        name: "execute-sql",
        inputSchema: objectSchema({
          region: { oneOf: [{ type: "string", "x-mcp-header": "Region" }] },
        }),
      },
    ]);
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [CHECK_ID],
      checkTimeout: 10_000,
    }).run();

    const advice = result.readiness?.find(
      (entry) => entry.id === "readiness-x-mcp-header-declarations",
    );
    expect(advice?.specStrength).toBe("SHOULD");
    expect(advice?.message).toMatch(/invisible rather than merely losing a header/);
    expect(advice?.details).toMatchObject({
      invalid: [{ tool: "execute-sql" }],
    });
  });

  it("stays silent when every declaration is valid", async () => {
    const serverUrl = await serveTools([
      {
        name: "execute-sql",
        inputSchema: objectSchema({
          region: { type: "string", "x-mcp-header": "Region" },
        }),
      },
    ]);
    const result = await new MCPConformanceTest({
      serverUrl,
      protocolVersion: MODERN,
      checkIds: [CHECK_ID],
      checkTimeout: 10_000,
    }).run();

    expect(
      result.readiness?.find(
        (entry) => entry.id === "readiness-x-mcp-header-declarations",
      ),
    ).toBeUndefined();
  });
});

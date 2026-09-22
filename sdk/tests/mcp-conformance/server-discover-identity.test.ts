/**
 * `modern-server-discover` reads identity where 2026 actually puts it.
 *
 * `DiscoverResult` has no `serverInfo` member — the 2026 encode seam stamps
 * `_meta["io.modelcontextprotocol/serverInfo"]` on every result instead (spec
 * PR #3002). The check used to demand a top-level `serverInfo`, so it failed
 * every spec-correct server, the official server SDK included.
 *
 * These fixtures are raw HTTP rather than a real handler on purpose: the SDK
 * always stamps, so a server that omits identity — or malforms it — cannot be
 * expressed with one.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";

const MODERN = "2026-07-28" as const;
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const closers: Array<() => Promise<void>> = [];

/** Answers `server/discover` with the supplied result verbatim. */
async function serveDiscover(result: Record<string, unknown>): Promise<string> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // The readiness pass probes with a deliberately unparseable body; a
      // fixture that throws on it would hang that request forever.
      let id: unknown = 1;
      try {
        id = (JSON.parse(body || "{}") as { id?: unknown }).id ?? 1;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          })
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(
    () => new Promise<void>((resolve) => httpServer.close(() => resolve()))
  );
  return `http://127.0.0.1:${port}/mcp`;
}

async function runDiscoverCheck(
  result: Record<string, unknown>
): Promise<MCPCheckResult> {
  const serverUrl = await serveDiscover(result);
  const run = await new MCPConformanceTest({
    serverUrl,
    protocolVersion: MODERN,
    checkIds: ["modern-server-discover"],
  }).run();
  const check = run.checks.find((c) => c.id === "modern-server-discover");
  if (!check) throw new Error("modern-server-discover did not run");
  return check;
}

const baseResult = {
  supportedVersions: [MODERN],
  capabilities: { tools: { listChanged: true } },
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "private",
} as const;

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("modern-server-discover identity", () => {
  it("passes on the _meta stamp, which is where the spec puts identity", async () => {
    const check = await runDiscoverCheck({
      ...baseResult,
      _meta: {
        [SERVER_INFO_META_KEY]: { name: "fixture", version: "1.0.0" },
      },
    });

    expect(check.status).toBe("passed");
    expect(check.details?.serverInfo).toEqual({
      name: "fixture",
      version: "1.0.0",
    });
  });

  it("still accepts a top-level serverInfo as a lenient fallback", async () => {
    const check = await runDiscoverCheck({
      ...baseResult,
      serverInfo: { name: "fixture", version: "1.0.0" },
    });

    expect(check.status).toBe("passed");
  });

  it("does not fail a server that stays silent — identity is a SHOULD", async () => {
    const check = await runDiscoverCheck({ ...baseResult });

    expect(check.status).toBe("passed");
    // Reported as null so the absence is visible in the run artifact rather
    // than indistinguishable from a check that never looked.
    expect(check.details?.serverInfo).toBeNull();
  });

  it("fails a present-but-malformed stamp", async () => {
    const check = await runDiscoverCheck({
      ...baseResult,
      _meta: { [SERVER_INFO_META_KEY]: { name: "fixture" } },
    });

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(SERVER_INFO_META_KEY);
  });

  it("still fails on the MUST members", async () => {
    const check = await runDiscoverCheck({
      ...baseResult,
      supportedVersions: [],
    });

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("supportedVersions");
  });
});

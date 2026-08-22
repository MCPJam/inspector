import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody, requestId } from "../support/json-rpc-fixture.js";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";

const MODERN = "2026-07-28" as const;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface HeaderFixtureOptions {
  /** Reject a request missing `Mcp-Method` with 400 + -32020. */
  requireMethodHeader?: boolean;
  /** Reject a request missing `MCP-Protocol-Version` with 400 + -32020. */
  requireProtocolVersionHeader?: boolean;
  /**
   * Match the standard header names with an EXACT string comparison rather
   * than case-insensitively — the defect the case-insensitivity MUST catches.
   */
  caseSensitiveHeaderNames?: boolean;
}

const CANONICAL_NAMES = ["MCP-Protocol-Version", "Mcp-Method"] as const;

/**
 * A hand-rolled 2026 endpoint, because the behavior under test is how the
 * server reads its REQUEST HEADERS — which a server framework normalizes away
 * before any handler can misread them.
 *
 * Node lowercases `req.headers` keys, so `rawHeaders` (which preserves the
 * bytes as sent) is what the case-sensitive variant compares against. That is
 * also the proof the probe's casing survives the transport at all.
 */
async function serveHeaderFixture(options: HeaderFixtureOptions) {
  const server = http.createServer((req, res) => {
    const sentNames: string[] = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      sentNames.push(req.rawHeaders[index]!);
    }

    const has = (canonical: string): boolean =>
      options.caseSensitiveHeaderNames
        ? sentNames.includes(canonical)
        : sentNames.some(
            (name) => name.toLowerCase() === canonical.toLowerCase(),
          );

    void (async () => {
      const parsed = await readJsonRpcBody(req, res);
      if (!parsed) return;
      const id = requestId(parsed);

      const missing = CANONICAL_NAMES.filter((name) => {
        if (name === "Mcp-Method" && !options.requireMethodHeader) return false;
        if (
          name === "MCP-Protocol-Version" &&
          !options.requireProtocolVersionHeader
        ) {
          return false;
        }
        return !has(name);
      });

      if (missing.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32020,
              message: `Missing required header(s): ${missing.join(", ")}`,
            },
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: String(parsed.method ?? ""),
            ttlMs: 0,
            cacheScope: "public",
            supportedVersions: [MODERN],
            capabilities: {},
          },
        }),
      );
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

async function run(options: HeaderFixtureOptions, checkIds: MCPCheckId[]) {
  const url = await serveHeaderFixture(options);
  const result = await new MCPConformanceTest({
    serverUrl: url,
    protocolVersion: MODERN,
    checkTimeout: 5_000,
    checkIds,
  }).run();
  return result;
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`check ${id} not found`);
  return found;
}

describe("modern-missing-method-header-rejected", () => {
  const ID: MCPCheckId = "modern-missing-method-header-rejected";

  it("passes a server that rejects the omission with 400 and -32020", async () => {
    const result = await run({ requireMethodHeader: true }, [ID]);
    const check = byId(result.checks, ID);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
    expect(check.details).toMatchObject({ httpStatus: 400, jsonRpcCode: -32020 });
  });

  it("fails a server that serves the request anyway", async () => {
    const result = await run({}, [ID]);
    const check = byId(result.checks, ID);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("expected HTTP 400, got HTTP 200");
  });
});

describe("modern-header-names-case-insensitive", () => {
  const ID: MCPCheckId = "modern-header-names-case-insensitive";

  it("passes a server that compares header names case-insensitively", async () => {
    const result = await run(
      { requireMethodHeader: true, requireProtocolVersionHeader: true },
      [ID],
    );
    const check = byId(result.checks, ID);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
    // Non-vacuity: the probe really did send non-canonical names, so a pass is
    // a statement about the server rather than about our own framing.
    expect(check.details?.sentHeaderNames).toEqual([
      "cOnTeNt-TyPe",
      "aCcEpT",
      "mCp-PrOtOcOl-VeRsIoN",
      "mCp-MeThOd",
    ]);
  });

  it("fails a server that matches header names by exact string", async () => {
    const result = await run(
      {
        requireMethodHeader: true,
        requireProtocolVersionHeader: true,
        caseSensitiveHeaderNames: true,
      },
      [ID],
    );
    const check = byId(result.checks, ID);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("case-insensitive");
  });
});

describe("readiness-protocol-version-header-required", () => {
  it("advises when the server serves a POST with no protocol-version header", async () => {
    // Advice, never a failure: the spec lets a server that still supports
    // pre-2025-06-18 clients tolerate the omission.
    const result = await run({}, ["modern-server-discover"]);
    const advisory = result.readiness.find(
      (entry) => entry.id === "readiness-protocol-version-header-required",
    );
    expect(advisory?.specStrength).toBe("SHOULD");
    expect(advisory?.severity).toBe("warning");
    expect(result.checks.some((check) => check.status === "failed")).toBe(false);
  });

  it("stays silent when the server rejects the omission", async () => {
    const result = await run({ requireProtocolVersionHeader: true }, [
      "modern-server-discover",
    ]);
    expect(
      result.readiness.some(
        (entry) => entry.id === "readiness-protocol-version-header-required",
      ),
    ).toBe(false);
  });
});

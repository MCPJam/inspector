import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
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

interface CacheFixtureOptions {
  /** Per-method hint overrides. `null` drops the field entirely. */
  hints?: Record<string, { ttlMs?: number | null; cacheScope?: unknown }>;
  /** Serve `tools/list` as two pages, with these cacheScope values in order. */
  toolsPageScopes?: unknown[];
  /** Answer a read of an unknown resource with `{ contents: [] }`. */
  emptyContentsForMissing?: boolean;
  /** Include `error.data.uri` on a resource error. */
  echoUriOnResourceError?: boolean;
}

const LISTED_RESOURCE = "test://greeting";

/**
 * A hand-rolled 2026 endpoint. The defects under test are what a server puts in
 * its RESULT — a fractional `ttlMs`, a `cacheScope` that is neither value, a
 * page that changes scope mid-walk — none of which a conforming server
 * framework will emit on request.
 */
async function serveCacheFixture(options: CacheFixtureOptions) {
  const hintFor = (method: string) => {
    const override = options.hints?.[method];
    const out: Record<string, unknown> = {};
    if (override?.ttlMs !== null) out.ttlMs = override?.ttlMs ?? 60_000;
    if (override && "cacheScope" in override) {
      if (override.cacheScope !== null) out.cacheScope = override.cacheScope;
    } else {
      out.cacheScope = "public";
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // The readiness lane deliberately POSTs an unparseable body. Letting
      // that throw here kills the handler and every probe after it hangs to
      // its timeout, which is a fixture bug that reads as a product one.
      let parsed: {
        id?: unknown;
        method?: string;
        params?: { uri?: string; cursor?: string };
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
        return;
      }
      const id = (parsed.id as string | number | null) ?? null;
      const method = parsed.method ?? "";
      const send = (payload: unknown, status = 200) =>
        res
          .writeHead(status, { "Content-Type": "application/json" })
          .end(JSON.stringify(payload));
      const ok = (result: Record<string, unknown>) =>
        send({
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", ...hintFor(method), ...result },
        });

      switch (method) {
        case "server/discover":
          return ok({
            supportedVersions: [MODERN],
            capabilities: { tools: {}, prompts: {}, resources: {} },
          });
        case "tools/list": {
          if (options.toolsPageScopes) {
            const page = parsed.params?.cursor === "p2" ? 1 : 0;
            return send({
              jsonrpc: "2.0",
              id,
              result: {
                resultType: "complete",
                tools: [],
                ttlMs: 60_000,
                cacheScope: options.toolsPageScopes[page],
                ...(page === 0 ? { nextCursor: "p2" } : {}),
              },
            });
          }
          return ok({ tools: [] });
        }
        case "prompts/list":
          return ok({ prompts: [] });
        case "resources/list":
          return ok({
            resources: [{ uri: LISTED_RESOURCE, name: "greeting" }],
          });
        case "resources/templates/list":
          return ok({ resourceTemplates: [] });
        case "resources/read": {
          const uri = parsed.params?.uri ?? "";
          if (uri === LISTED_RESOURCE) {
            return ok({
              contents: [{ uri, mimeType: "text/plain", text: "hello" }],
            });
          }
          if (options.emptyContentsForMissing) {
            return ok({ contents: [] });
          }
          return send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Resource not found",
              ...(options.echoUriOnResourceError ? { data: { uri } } : {}),
            },
          });
        }
        default:
          return send(
            {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${method}` },
            },
            404,
          );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${port}/mcp`;
}

async function run(options: CacheFixtureOptions, checkIds: MCPCheckId[]) {
  const url = await serveCacheFixture(options);
  return await new MCPConformanceTest({
    serverUrl: url,
    protocolVersion: MODERN,
    checkTimeout: 5_000,
    checkIds,
  }).run();
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`check ${id} not found`);
  return found;
}

describe("modern-cache-hint-coverage", () => {
  const ID: MCPCheckId = "modern-cache-hint-coverage";

  it("passes a server that hints on all six cacheable operations", async () => {
    const check = byId((await run({}, [ID])).checks, ID);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
    // Non-vacuity: all six were actually reached, including the two the older
    // check never probed.
    expect(Object.keys(check.details?.cacheHints as object)).toEqual([
      "server/discover",
      "tools/list",
      "prompts/list",
      "resources/list",
      "resources/templates/list",
      "resources/read",
    ]);
  });

  it("catches a miss on resources/read, which the older check never probed", async () => {
    const check = byId(
      (await run({ hints: { "resources/read": { ttlMs: null } } }, [ID]))
        .checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("resources/read");
    expect(check.error?.message).toContain("ttlMs");
  });

  it("catches a miss on resources/templates/list", async () => {
    const check = byId(
      (await run(
        { hints: { "resources/templates/list": { cacheScope: null } } },
        [ID],
      )).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("resources/templates/list");
  });
});

describe("modern-cache-hint-values-valid", () => {
  const ID: MCPCheckId = "modern-cache-hint-values-valid";

  it("passes integer, non-negative ttlMs with a known cacheScope", async () => {
    const check = byId((await run({}, [ID])).checks, ID);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails a negative ttlMs", async () => {
    const check = byId(
      (await run({ hints: { "tools/list": { ttlMs: -1 } } }, [ID])).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("negative");
  });

  it("fails a fractional ttlMs", async () => {
    const check = byId(
      (await run({ hints: { "tools/list": { ttlMs: 1.5 } } }, [ID])).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("not an integer");
  });

  it("fails a cacheScope outside the two allowed values", async () => {
    const check = byId(
      (await run({ hints: { "tools/list": { cacheScope: "shared" } } }, [ID]))
        .checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("public | private");
  });

  it("accepts ttlMs: 0, which is legal and only advisable against", async () => {
    // The uselessness of a zero TTL stays on the readiness channel; the schema
    // allows it via `minimum: 0`, so a check must not fail it.
    const check = byId(
      (await run({ hints: { "tools/list": { ttlMs: 0 } } }, [ID])).checks,
      ID,
    );
    expect(check.status).toBe("passed");
  });
});

describe("modern-cache-scope-stable-across-pages", () => {
  const ID: MCPCheckId = "modern-cache-scope-stable-across-pages";

  it("passes when every page carries the same scope", async () => {
    const check = byId(
      (await run({ toolsPageScopes: ["private", "private"] }, [ID])).checks,
      ID,
    );
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails when a later page changes scope", async () => {
    const check = byId(
      (await run({ toolsPageScopes: ["private", "public"] }, [ID])).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("tools/list");
  });

  it("skips rather than passes when nothing paginates", async () => {
    // One page establishes nothing about page-to-page consistency, so a pass
    // would be certifying an observation the run never made.
    const check = byId((await run({}, [ID])).checks, ID);
    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "not-applicable",
    ]);
  });
});

describe("modern-resource-read-no-empty-contents", () => {
  const ID: MCPCheckId = "modern-resource-read-no-empty-contents";

  it("passes a server that answers a JSON-RPC error", async () => {
    const check = byId((await run({}, [ID])).checks, ID);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("fails a server that answers an empty contents array", async () => {
    const check = byId(
      (await run({ emptyContentsForMissing: true }, [ID])).checks,
      ID,
    );
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain("empty contents array");
  });

  it("is a separate obligation from the -32602 code", async () => {
    // Both checks read the same probe. A server can answer `{ contents: [] }`
    // (no error at all) — which the code check reports separately — so the two
    // must not be collapsed.
    const result = await run({ emptyContentsForMissing: true }, [
      "modern-resource-not-found-invalid-params",
      ID,
    ]);
    expect(
      result.checks.map((check) => [check.id, check.status]).sort(),
    ).toEqual([
      ["modern-resource-not-found-invalid-params", "failed"],
      ["modern-resource-read-no-empty-contents", "failed"],
    ]);
  });
});

describe("readiness-resource-error-echoes-uri", () => {
  it("advises when a resource error names no uri", async () => {
    const result = await run({}, ["modern-resource-not-found-invalid-params"]);
    const advisory = result.readiness.find(
      (entry) => entry.id === "readiness-resource-error-echoes-uri",
    );
    expect(advisory?.specStrength).toBe("MAY");
    expect(result.checks.some((check) => check.status === "failed")).toBe(false);
  });

  it("stays silent when the error echoes the uri", async () => {
    const result = await run({ echoUriOnResourceError: true }, [
      "modern-resource-not-found-invalid-params",
    ]);
    expect(
      result.readiness.some(
        (entry) => entry.id === "readiness-resource-error-echoes-uri",
      ),
    ).toBe(false);
  });
});

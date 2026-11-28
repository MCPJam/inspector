/**
 * The tool-order advice against a real server that sends cache hints.
 *
 * A 2026-07-28 server may put `ttlMs` on its `tools/list` result, and the MCP
 * client then answers a repeat listing from its own cache. The advice works by
 * listing the tools twice and comparing, so a repeat listing served from the
 * cache compares the first answer with itself and can never warn. These tests
 * count the listings that reach the server, which is the only place that shows
 * whether the second one was real.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  MCPConformanceTest,
  type MCPConformanceResult,
} from "../../src/mcp-conformance/index.js";
import {
  CACHE_FIXTURE_SERVER_INFO,
  CACHE_FIXTURE_TTL_MS,
  serveCountingFixtureOnPort,
  type ServedCountingFixture,
} from "../support/cache-fixture.js";

const MODERN = "2026-07-28" as const;
const TOOL_NAMES = ["alpha", "beta", "gamma"] as const;
const ADDED_TOOL = "delta";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * What the second `tools/list` answers, compared with the first:
 * - `same`: the same tools in the same order.
 * - `reversed`: the same tools in the reverse order.
 * - `grown`: the reverse order again, plus a tool the first listing did not have.
 */
type SecondListing = "same" | "reversed" | "grown";

/**
 * A server whose `tools/list` carries `ttlMs` and lists three tools.
 *
 * The server is built per request, so the listing is chosen when a request
 * arrives. The count already includes the request being answered, so the
 * first listing is always the three tools in order.
 */
async function serveToolOrderFixture(options: {
  secondListing: SecondListing;
}): Promise<ServedCountingFixture> {
  let fixture: ServedCountingFixture | undefined;
  const handler = createMcpHandler(() => {
    const server = new McpServer(CACHE_FIXTURE_SERVER_INFO, {
      capabilities: { tools: {} },
      cacheHints: {
        "tools/list": { ttlMs: CACHE_FIXTURE_TTL_MS, cacheScope: "public" },
      },
    });
    const isSecondListing = (fixture?.count("tools/list") ?? 0) % 2 === 0;
    const names: string[] = [...TOOL_NAMES];
    if (isSecondListing && options.secondListing !== "same") {
      names.reverse();
      if (options.secondListing === "grown") names.push(ADDED_TOOL);
    }
    for (const name of names) {
      server.registerTool(
        name,
        { description: `The ${name} tool.` },
        async () => ({ content: [{ type: "text" as const, text: name }] })
      );
    }
    return server;
  });
  fixture = await serveCountingFixtureOnPort(handler);
  closers.push(fixture.close);
  return fixture;
}

async function runToolOrderAdvice(
  serverUrl: string
): Promise<MCPConformanceResult> {
  return await new MCPConformanceTest({
    serverUrl,
    protocolVersion: MODERN,
    // The advice is collected on the client session, which a pinned run only
    // opens when a client check is selected.
    checkIds: ["server-initialize"],
    readinessIds: ["readiness-tool-order-deterministic"],
    checkTimeout: 10_000,
  }).run();
}

function toolOrderAdvice(result: MCPConformanceResult) {
  return result.readiness?.find(
    (warning) => warning.id === "readiness-tool-order-deterministic"
  );
}

describe("tool-order advice on a server that sends ttlMs", () => {
  it("warns when the server lists its tools in a different order each time", async () => {
    const fixture = await serveToolOrderFixture({ secondListing: "reversed" });

    const result = await runToolOrderAdvice(fixture.url);

    // Two listings on the wire: the repeat one was not answered from the cache.
    expect(fixture.count("tools/list")).toBe(2);
    const advice = toolOrderAdvice(result);
    expect(advice).toBeDefined();
    expect(advice?.details).toMatchObject({
      firstListing: [...TOOL_NAMES],
      secondListing: [...TOOL_NAMES].reverse(),
    });
  });

  it("stays silent when the order is the same on both listings", async () => {
    const fixture = await serveToolOrderFixture({ secondListing: "same" });

    const result = await runToolOrderAdvice(fixture.url);

    // Silence means something only because the second listing was real.
    expect(fixture.count("tools/list")).toBe(2);
    expect(toolOrderAdvice(result)).toBeUndefined();
  });

  it("stays silent when the set of tools changed between the listings", async () => {
    // The spec asks for the same order only "when the underlying set of tools
    // has not changed". Here a tool appeared, so the new order breaks no rule.
    const fixture = await serveToolOrderFixture({ secondListing: "grown" });

    const result = await runToolOrderAdvice(fixture.url);

    expect(fixture.count("tools/list")).toBe(2);
    expect(toolOrderAdvice(result)).toBeUndefined();
  });
});

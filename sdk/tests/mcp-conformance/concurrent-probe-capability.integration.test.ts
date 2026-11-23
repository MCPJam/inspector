/**
 * Multiple POST Streams and Functional SSE Streams against a real HTTP server
 * that answers only what its `initialize` declared. A listing it did not
 * declare gets HTTP 404, as from a server without that feature.
 *
 * The server logs each request, so the assertions are about what reached it.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckId,
} from "../../src/mcp-conformance/index.js";
import {
  serveCapabilityServer,
  type CapabilityServerOptions,
} from "../support/capability-server.js";

const POSTS: MCPCheckId = "server-accepts-multiple-post-streams";
const SSE: MCPCheckId = "server-sse-streams-functional";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function run(options: CapabilityServerOptions) {
  const served = await serveCapabilityServer(options);
  cleanups.push(served.close);
  const result = await new MCPConformanceTest({
    serverUrl: served.url,
    protocolVersion: "2025-11-25",
    checkTimeout: 5_000,
    checkIds: [POSTS, SSE],
    readinessIds: [],
  }).run();
  const find = (id: MCPCheckId) =>
    result.checks.find((check) => check.id === id);
  return {
    sent: (method: string) =>
      served.log.filter((line) => line === `POST ${method}`).length,
    verdict: (id: MCPCheckId) => [
      find(id)?.status,
      find(id)?.skipReason,
      find(id)?.error?.message,
    ],
  };
}

describe("a server that declares prompts and no tools", () => {
  it("is sent three prompts/list, never a tools/list, and passes both checks", async () => {
    const { sent, verdict } = await run({
      capabilities: { prompts: {} },
      listings: "sse",
    });

    expect(sent("tools/list")).toBe(0);
    expect(sent("prompts/list")).toBe(3);
    // With tools/list the three requests are answered 404 and both checks
    // fail a server that did nothing wrong.
    expect(verdict(POSTS)).toEqual(["passed", undefined, undefined]);
    expect(verdict(SSE)).toEqual(["passed", undefined, undefined]);
  });
});

describe("a server that declares nothing to list", () => {
  it("is sent three pings, and the SSE check says it had nothing to check", async () => {
    const { sent, verdict } = await run({ capabilities: { logging: {} } });

    expect(sent("tools/list")).toBe(0);
    expect(sent("ping")).toBe(3);
    expect(verdict(POSTS)).toEqual(["passed", undefined, undefined]);
    expect(verdict(SSE)).toEqual([
      "skipped",
      "not-applicable",
      "The server declares no tools, prompts or resources, so the probe was a ping, and it was answered as JSON. No SSE stream was opened to check.",
    ]);
  });
});

describe("a server that declares tools", () => {
  it("is still sent three tools/list", async () => {
    const { sent, verdict } = await run({
      capabilities: { tools: {}, prompts: {} },
      listings: "sse",
    });

    expect(sent("tools/list")).toBe(3);
    expect(sent("prompts/list")).toBe(0);
    expect(verdict(POSTS)).toEqual(["passed", undefined, undefined]);
    expect(verdict(SSE)).toEqual(["passed", undefined, undefined]);
  });
});

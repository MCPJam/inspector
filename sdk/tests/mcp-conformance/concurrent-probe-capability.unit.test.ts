/**
 * The request Multiple POST Streams and Functional SSE Streams send three
 * times at once on a 2025-era session.
 *
 * "Both parties MUST ... only use capabilities that were successfully
 * negotiated" (SHOULD in 2025-03-26). The probes sent `tools/list` to every
 * server, including one whose `initialize` answer declared no tools. They now
 * send the listing of a capability the server did declare, and a `ping` when
 * it declared none.
 *
 * The scripted server refuses a listing it did not declare, so a probe that
 * ignores the capabilities gets a 404 and the check blames the server for it.
 */

import { describe, expect, it } from "vitest";
import { concurrentProbe } from "../../src/mcp-conformance/checks/concurrent-probe.js";
import { runTransportChecks } from "../../src/mcp-conformance/checks/transport.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  capabilityServerFetch,
  type CapabilityLog,
  type CapabilityServerOptions,
} from "../support/capability-server.js";

type LegacyVersion = "2025-11-25" | "2025-06-18" | "2025-03-26";
const LEGACY_VERSIONS: LegacyVersion[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
const POSTS: MCPCheckId = "server-accepts-multiple-post-streams";
const SSE: MCPCheckId = "server-sse-streams-functional";

describe("concurrentProbe picks a request the server agreed to", () => {
  it.each([
    ["tools", { tools: {} }, "tools/list", "tools"],
    ["only prompts", { prompts: {} }, "prompts/list", "prompts"],
    ["only resources", { resources: {} }, "resources/list", "resources"],
    [
      "tools next to the others",
      { resources: {}, prompts: {}, tools: { listChanged: true } },
      "tools/list",
      "tools",
    ],
    [
      "prompts and resources",
      { resources: {}, prompts: {} },
      "prompts/list",
      "prompts",
    ],
  ])("lists %s", (_label, capabilities, method, capability) => {
    const probe = concurrentProbe(capabilities);
    expect([probe.method, probe.capability]).toEqual([method, capability]);
    // A listing goes out with empty params.
    expect(probe.body(7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method,
      params: {},
    });
  });

  it.each([
    ["nothing", {}],
    ["only capabilities with no listing", { logging: {}, completions: {} }],
    ["tools as null", { tools: null }],
    ["no capabilities object", undefined],
    ["something that is not an object", "tools"],
  ])("pings a server that declares %s", (_label, capabilities) => {
    const probe = concurrentProbe(capabilities);
    expect([probe.method, probe.capability]).toEqual(["ping", undefined]);
    // A ping goes out with no params at all.
    expect(probe.body(7)).toEqual({ jsonrpc: "2.0", id: 7, method: "ping" });
  });
});

async function run(
  options: CapabilityServerOptions,
  protocolVersion: LegacyVersion = "2025-11-25"
) {
  const log: CapabilityLog = [];
  const bodies: Array<Record<string, unknown>> = [];
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://capabilities.example.test/mcp",
    protocolVersion,
    checkTimeout: 500,
    fetchFn: capabilityServerFetch(options, log, bodies),
  });
  const ctx: RawHttpCheckContext = {
    config,
    serverUrl: config.serverUrl,
    fetchFn: config.fetchFn,
  };
  const results = await runTransportChecks(ctx, new Set([POSTS, SSE]));
  const byId = (id: MCPCheckId): MCPCheckResult => {
    const found = results.find((result) => result.id === id);
    if (!found) throw new Error(`check ${id} not in results`);
    return found;
  };
  const sent = (method: string) =>
    log.filter((line) => line === `POST ${method}`).length;
  return { byId, sent, bodies };
}

describe.each(LEGACY_VERSIONS)("the concurrent probes on %s", (version) => {
  it("send tools/list to a server that declares tools, as before", async () => {
    const { byId, sent } = await run({ capabilities: { tools: {} } }, version);

    expect(sent("tools/list")).toBe(3);
    expect(byId(POSTS).status).toBe("passed");
    expect(byId(POSTS).details).toMatchObject({ probeMethod: "tools/list" });
  });

  it("send the listing it declared to a server with no tools", async () => {
    const { byId, sent } = await run(
      { capabilities: { prompts: {}, logging: {} } },
      version
    );

    // The server answers 404 to tools/list. Three of those used to fail
    // Multiple POST Streams: "Expected all concurrent POST requests to return
    // 2xx, got 404, 404, 404".
    expect(sent("tools/list")).toBe(0);
    expect(sent("prompts/list")).toBe(3);
    expect([byId(POSTS).status, byId(POSTS).error?.message]).toEqual([
      "passed",
      undefined,
    ]);
    expect(byId(POSTS).details).toMatchObject({ probeMethod: "prompts/list" });
    expect(byId(SSE).status).toBe("passed");
  });

  it("send a ping to a server that declares nothing to list", async () => {
    const { byId, sent, bodies } = await run(
      { capabilities: { logging: {} } },
      version
    );

    expect(
      sent("tools/list") + sent("prompts/list") + sent("resources/list")
    ).toBe(0);
    expect(sent("ping")).toBe(3);
    // A ping carries no params.
    for (const body of bodies.filter((entry) => entry.method === "ping")) {
      expect(body).not.toHaveProperty("params");
    }
    expect(byId(POSTS).status).toBe("passed");
    expect(byId(POSTS).details).toMatchObject({ probeMethod: "ping" });
  });
});

describe("Functional SSE Streams and the ping fallback", () => {
  it("is not applicable when the pings come back as JSON", async () => {
    const { byId } = await run({ capabilities: {} });

    // Nothing was streamed, and a ping is not a request a server streams: a
    // pass here would claim SSE works without having seen any.
    expect([byId(SSE).status, byId(SSE).skipReason]).toEqual([
      "skipped",
      "not-applicable",
    ]);
    expect(byId(SSE).error?.message).toBe(
      "The server declares no tools, prompts or resources, so the probe was a ping, and it was answered as JSON. No SSE stream was opened to check."
    );
  });

  it("grades the streams when the pings come back as SSE", async () => {
    const { byId } = await run({ capabilities: {}, ping: "sse" });

    expect(byId(SSE).status).toBe("passed");
    expect(byId(SSE).details).toMatchObject({
      probeMethod: "ping",
      sseStreamCount: 3,
    });
  });

  it("still passes JSON answers to a declared listing, as before", async () => {
    const { byId } = await run({ capabilities: { tools: {} } });

    expect(byId(SSE).status).toBe("passed");
    expect(byId(SSE).details).toMatchObject({ probeMethod: "tools/list" });
  });

  it("still catches a broken stream on a declared listing", async () => {
    // A server that answers ping as plain JSON but streams its listings, and
    // streams them badly. A ping-only probe would never see the stream.
    const { byId, sent } = await run({
      capabilities: { tools: {} },
      listings: "broken-sse",
      ping: "json",
    });

    expect(sent("tools/list")).toBe(3);
    expect(sent("ping")).toBe(0);
    expect(byId(SSE).status).toBe("failed");
    expect(byId(SSE).error?.message).toContain("no readable events");
  });
});

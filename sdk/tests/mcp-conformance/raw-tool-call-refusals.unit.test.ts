/**
 * What the hand-made tool calls do when the `Mcp-Param-*` retry does not go
 * cleanly: the server keeps refusing, the fresh `tools/list` cannot be read,
 * the client's own listing is the stale one, or the refused first answer said
 * something a check must not miss.
 *
 * The happy path is in `raw-tool-call-param-headers.unit.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import {
  mirroredToolCall,
  type RawHttpResult,
} from "../../src/mcp-conformance/raw-http.js";
import type {
  MCPCheckId,
  MCPCheckResult,
  MCPServerSurfaceSnapshot,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  REGION_TOOL,
  regionServerFetch,
  type RegionServerLog,
  type RegionServerOptions,
} from "../support/region-tool-server.js";

const PROBE = { toolName: REGION_TOOL, arguments: { region: "us-west1" } };
const CAPABILITY: MCPCheckId = "modern-undeclared-capability-error";
const OUTPUT_SCHEMA: MCPCheckId = "modern-tool-output-schema-conformant";
const LOGS: MCPCheckId = "modern-logs-require-log-level";

async function runChecks(
  ids: MCPCheckId[],
  options: RegionServerOptions,
  log: RegionServerLog,
  extra: {
    surface?: MCPServerSurfaceSnapshot;
    toolCalls?: Array<typeof PROBE>;
  } = {}
): Promise<MCPCheckResult[]> {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://region.example.test/mcp",
    protocolVersion: "2026-07-28",
    fixtures: { toolCalls: extra.toolCalls ?? [PROBE] },
    inputRequiredProbe: PROBE,
    logProbe: PROBE,
    fetchFn: regionServerFetch(options, log),
  });
  return await runModernChecks(
    {
      config,
      serverUrl: config.serverUrl,
      fetchFn: config.fetchFn,
      surface: extra.surface,
    },
    new Set(ids)
  );
}

const byId = (results: MCPCheckResult[], id: MCPCheckId) => {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`check ${id} not in results`);
  return found;
};
const calls = (log: RegionServerLog) =>
  log.filter((line) => line.startsWith("tools/call"));
const listings = (log: RegionServerLog) =>
  log.filter((line) => line.startsWith("tools/list"));

describe("Undeclared Client Capability when the server keeps refusing the headers", () => {
  it.each<[string, RegionServerOptions]>([
    ["refuses whatever headers it gets", { alwaysRefuse: true }],
    [
      // One valid mark and one the spec does not allow: the schema is invalid,
      // so there is no header to send and both tries are refused.
      "marks two arguments with the same header name",
      { duplicateMark: true },
    ],
  ])("could not run when the server %s", async (_why, options) => {
    const log: RegionServerLog = [];
    const check = byId(await runChecks([CAPABILITY], options, log), CAPABILITY);

    expect(calls(log)).toHaveLength(2);
    // Not the wrong red failure: "expected -32021, got -32020".
    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toContain("JSON-RPC -32020");
    expect(check.error?.message).not.toContain("-32021");
    expect(check.details).toMatchObject({
      httpStatus: 400,
      jsonRpcCode: -32020,
    });
  });
});

describe("a fresh tools/list that cannot be read", () => {
  it.each(["malformed", "unreachable"] as const)(
    "leaves the first listing in place for later checks (%s)",
    async (how) => {
      const log: RegionServerLog = [];
      // Raw-only run. The first listing has no mark, so the first call is
      // refused and the tools are listed again. That second listing is the
      // broken one.
      const results = await runChecks(
        [CAPABILITY, OUTPUT_SCHEMA],
        { listingsWithoutTheMark: 1, brokenListing: { nth: 2, how } },
        log
      );

      // Tool Output Schema Honored reads the shared listing afterwards. With
      // the broken walk in its place it would throw and be marked failed.
      const outputSchema = byId(results, OUTPUT_SCHEMA);
      expect(outputSchema.status).not.toBe("failed");
      expect(listings(log)[0]).toBe("tools/list (without the mark)");
      expect(listings(log)[1]).toBe(`tools/list (${how})`);
    }
  );
});

describe("a client listing that went stale", () => {
  /** What the SDK client listed before the server started marking `region`. */
  const staleSurface: MCPServerSurfaceSnapshot = {
    tools: [
      {
        name: REGION_TOOL,
        inputSchema: {
          type: "object",
          properties: { region: { type: "string" } },
        },
        // With an output schema in the snapshot the check lists nothing
        // itself, so the stale snapshot is all it has for the first call.
        outputSchema: {
          type: "object",
          properties: { greeting: { type: "string" } },
          required: ["greeting"],
        },
      },
    ] as MCPServerSurfaceSnapshot["tools"],
    toolNames: [REGION_TOOL],
    promptNames: [],
    resourceUris: [],
    resourceTemplateUris: [],
    serverCapabilities: { tools: {} },
  };

  it("is replaced by the fresh listing for every later call", async () => {
    const log: RegionServerLog = [];
    // Three calls to the same tool. Only the first is built from the stale
    // listing; the other two must use the one read after the refusal.
    await runChecks([OUTPUT_SCHEMA], {}, log, {
      surface: staleSurface,
      toolCalls: [PROBE, PROBE, PROBE],
    });

    expect(calls(log)).toEqual([
      "tools/call Mcp-Param-Region=(none)",
      "tools/call Mcp-Param-Region=us-west1",
      "tools/call Mcp-Param-Region=us-west1",
      "tools/call Mcp-Param-Region=us-west1",
    ]);
    expect(listings(log)).toEqual(["tools/list (with the mark)"]);
  });
});

describe("Logs Require A Log Level and a refused first try", () => {
  it("still fails a server that logged on the refused silent call", async () => {
    const log: RegionServerLog = [];
    // The silent call is refused once (stale listing) and the refusal carries
    // a log. The retry completes with no logs. The log on the first answer is
    // still a log on a request that asked for none.
    const check = byId(
      await runChecks(
        [LOGS],
        { listingsWithoutTheMark: 1, logOnRefusal: true },
        log
      ),
      LOGS
    );

    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      "emitted 1 log notification(s) for a request that carried no modern log level"
    );
  });

  it("still fails it when the retry then gets no answer", async () => {
    const log: RegionServerLog = [];
    // Same refused, logging first try, but the retry is a dropped connection.
    // The log already came back, so it is not lost to "could not run".
    const check = byId(
      await runChecks(
        [LOGS],
        { listingsWithoutTheMark: 1, logOnRefusal: true, unreachableCall: 2 },
        log
      ),
      LOGS
    );

    expect(calls(log)).toHaveLength(2);
    expect(check.status).toBe("failed");
    expect(check.error?.message).toContain(
      "emitted 1 log notification(s) for a request that carried no modern log level"
    );
  });

  it("could not run when the retry gets no answer and nothing logged", async () => {
    const log: RegionServerLog = [];
    const check = byId(
      await runChecks(
        [LOGS],
        { listingsWithoutTheMark: 1, unreachableCall: 2 },
        log
      ),
      LOGS
    );

    expect([check.status, check.skipReason]).toEqual([
      "skipped",
      "could-not-run",
    ]);
    expect(check.error?.message).toContain(
      "Could not complete the logging probe"
    );
  });

  it("does not blame a server whose refusal carried no log", async () => {
    const log: RegionServerLog = [];
    const check = byId(
      await runChecks([LOGS], { listingsWithoutTheMark: 1 }, log),
      LOGS
    );

    expect(check.error?.message ?? "").not.toContain("log notification(s) for");
  });
});

describe("mirroredToolCall when the tool's schema cannot be read", () => {
  it("still sends the call, with no Mcp-Param headers", async () => {
    const send = vi.fn(
      async () =>
        ({
          status: 200,
          headers: {},
          bodyText: "",
          json: { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } },
          sseEvents: [],
        }) as unknown as RawHttpResult
    );

    const result = await mirroredToolCall({
      args: { region: "eu" },
      inputSchema: async () => {
        throw new Error("connection reset");
      },
      refreshInputSchema: async () => undefined,
      send,
    });

    expect(result.status).toBe(200);
    expect(send.mock.calls).toEqual([[{}, 0]]);
  });
});

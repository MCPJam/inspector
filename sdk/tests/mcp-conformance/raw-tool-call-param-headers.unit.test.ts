/**
 * `Mcp-Param-*` headers on the tool calls the 2026-07-28 checks make by hand.
 *
 * "When a server's tool definition includes `x-mcp-header` annotations,
 * conforming clients MUST mirror the designated parameter values into HTTP
 * headers." And when the server still refuses with `HeaderMismatch`, "the
 * client SHOULD call `tools/list` to check for changes to the tool's
 * `inputSchema`, then retry the original request with the appropriate
 * headers."
 *
 * The scripted server refuses a call whose header is missing or wrong, as a
 * conforming server does, so a check only gets a result when the probe
 * mirrored the argument.
 */

import { describe, expect, it, vi } from "vitest";
import { runModernChecks } from "../../src/mcp-conformance/checks/modern.js";
import {
  mcpParamHeaders,
  mirroredToolCall,
  type RawHttpResult,
} from "../../src/mcp-conformance/raw-http.js";
import type { MCPCheckId } from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import {
  REGION_TOOL,
  regionServerFetch,
  type RegionServerLog,
  type RegionServerOptions,
} from "../support/region-tool-server.js";

const REGION_SCHEMA = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    count: { type: "integer", "x-mcp-header": "Count" },
    dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" },
    note: { type: "string" },
  },
};

describe("mcpParamHeaders", () => {
  it("mirrors each marked argument that has a value", () => {
    expect(
      mcpParamHeaders(REGION_SCHEMA, {
        region: "us-west1",
        count: 3,
        dryRun: false,
        note: "not marked",
      })
    ).toEqual({
      "Mcp-Param-Region": "us-west1",
      "Mcp-Param-Count": "3",
      "Mcp-Param-Dry-Run": "false",
    });
  });

  it("leaves out the header for a marked argument with no value", () => {
    expect(mcpParamHeaders(REGION_SCHEMA, { note: "only this" })).toEqual({});
    expect(mcpParamHeaders(REGION_SCHEMA, { region: null })).toEqual({});
  });

  it("encodes a value that is not plain ASCII", () => {
    const sent = mcpParamHeaders(REGION_SCHEMA, { region: "São Paulo" });
    expect(sent["Mcp-Param-Region"]).toMatch(/^=\?base64\?.+\?=$/);
    expect(
      Buffer.from(
        sent["Mcp-Param-Region"].slice("=?base64?".length, -2),
        "base64"
      ).toString("utf8")
    ).toBe("São Paulo");
  });

  it.each([
    ["the schema is unknown", undefined],
    ["the schema marks nothing", { type: "object", properties: {} }],
    [
      "two arguments claim the same header, which the spec forbids",
      {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          zone: { type: "string", "x-mcp-header": "region" },
        },
      },
    ],
  ])("sends none when %s", (_why, schema) => {
    expect(mcpParamHeaders(schema, { region: "eu", zone: "a" })).toEqual({});
  });
});

function answer(status: number, code?: number): RawHttpResult {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyText: "",
    json:
      code === undefined
        ? { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }
        : { jsonrpc: "2.0", id: 1, error: { code, message: "refused" } },
    sseEvents: [],
  } as unknown as RawHttpResult;
}

describe("mirroredToolCall", () => {
  const ARGS = { region: "eu" };
  const STALE = { type: "object", properties: { region: { type: "string" } } };

  it("sends once when the server accepts the call", async () => {
    const send = vi.fn(async () => answer(200));
    const refreshInputSchema = vi.fn(async () => REGION_SCHEMA);

    const result = await mirroredToolCall({
      args: ARGS,
      inputSchema: async () => REGION_SCHEMA,
      refreshInputSchema,
      send,
    });

    expect(result.status).toBe(200);
    expect(send.mock.calls).toEqual([[{ "Mcp-Param-Region": "eu" }, 0]]);
    expect(refreshInputSchema).not.toHaveBeenCalled();
  });

  it("lists the tools again and retries once after a HeaderMismatch", async () => {
    const send = vi
      .fn<
        (
          headers: Record<string, string>,
          attempt: 0 | 1
        ) => Promise<RawHttpResult>
      >()
      .mockResolvedValueOnce(answer(400, -32020))
      .mockResolvedValueOnce(answer(200));
    const refreshInputSchema = vi.fn(async () => REGION_SCHEMA);

    const result = await mirroredToolCall({
      args: ARGS,
      inputSchema: async () => STALE,
      refreshInputSchema,
      send,
    });

    expect(result.status).toBe(200);
    expect(refreshInputSchema).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toEqual([
      [{}, 0],
      [{ "Mcp-Param-Region": "eu" }, 1],
    ]);
  });

  it("never tries a third time", async () => {
    const send = vi.fn(async () => answer(400, -32020));

    const result = await mirroredToolCall({
      args: ARGS,
      inputSchema: async () => REGION_SCHEMA,
      refreshInputSchema: async () => REGION_SCHEMA,
      send,
    });

    expect(result.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["another JSON-RPC error", answer(400, -32602)],
    ["a HeaderMismatch code on a status that is not 400", answer(200, -32020)],
    ["a server error", answer(500)],
  ])("does not retry on %s", async (_why, refusal) => {
    const send = vi.fn(async () => refusal);
    const refreshInputSchema = vi.fn(async () => REGION_SCHEMA);

    await mirroredToolCall({
      args: ARGS,
      inputSchema: async () => REGION_SCHEMA,
      refreshInputSchema,
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(refreshInputSchema).not.toHaveBeenCalled();
  });

  it.each([
    ["the tool is gone from the new listing", async () => undefined],
    [
      "the new listing cannot be read",
      async () => {
        throw new Error("connection reset");
      },
    ],
  ])("keeps the refusal when %s", async (_why, refreshInputSchema) => {
    const send = vi.fn(async () => answer(400, -32020));

    const result = await mirroredToolCall({
      args: ARGS,
      inputSchema: async () => REGION_SCHEMA,
      refreshInputSchema,
      send,
    });

    expect(result.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

const PROBE = { toolName: REGION_TOOL, arguments: { region: "us-west1" } };

async function runCheck(
  id: MCPCheckId,
  options: RegionServerOptions,
  log: RegionServerLog
) {
  const config = normalizeMCPConformanceConfig({
    serverUrl: "https://region.example.test/mcp",
    protocolVersion: "2026-07-28",
    fixtures: { toolCalls: [PROBE] },
    inputRequiredProbe: PROBE,
    logProbe: PROBE,
    fetchFn: regionServerFetch(options, log),
  });
  const results = await runModernChecks(
    { config, serverUrl: config.serverUrl, fetchFn: config.fetchFn },
    new Set([id])
  );
  return results[0];
}

const calls = (log: RegionServerLog) =>
  log.filter((line) => line.startsWith("tools/call"));

describe("the checks that call a tool mirror its marked arguments", () => {
  it("Tool Output Schema Honored gets a result to grade", async () => {
    const log: RegionServerLog = [];
    const check = await runCheck(
      "modern-tool-output-schema-conformant",
      {},
      log
    );

    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
    expect(calls(log)).toEqual(["tools/call Mcp-Param-Region=us-west1"]);
  });

  it("Undeclared Client Capability is not failed for a refusal the probe caused", async () => {
    const log: RegionServerLog = [];
    const check = await runCheck("modern-undeclared-capability-error", {}, log);

    expect(calls(log)).toEqual(["tools/call Mcp-Param-Region=us-west1"]);
    // The tool completes without asking for input, so there is nothing to
    // grade. What matters is that it is no longer "expected -32021, got -32020".
    expect(check.status).not.toBe("failed");
    expect(check.error?.message ?? "").not.toContain("-32020");
  });

  it("Logs Require A Log Level sends the header on both of its calls", async () => {
    const log: RegionServerLog = [];
    await runCheck("modern-logs-require-log-level", {}, log);

    expect(calls(log)).toEqual([
      "tools/call Mcp-Param-Region=us-west1",
      "tools/call Mcp-Param-Region=us-west1",
    ]);
  });
});

describe("a tool whose schema changed after it was listed", () => {
  it("is listed again and called a second time with the new header", async () => {
    const log: RegionServerLog = [];
    const check = await runCheck(
      "modern-tool-output-schema-conformant",
      { listingsWithoutTheMark: 1 },
      log
    );

    expect(log.filter((line) => line !== "server/discover")).toEqual([
      "tools/list (without the mark)",
      "tools/call Mcp-Param-Region=(none)",
      "tools/list (with the mark)",
      "tools/call Mcp-Param-Region=us-west1",
    ]);
    expect([check.status, check.error?.message]).toEqual(["passed", undefined]);
  });

  it("is called twice at most when the server keeps refusing", async () => {
    const log: RegionServerLog = [];
    const check = await runCheck(
      "modern-tool-output-schema-conformant",
      { alwaysRefuse: true },
      log
    );

    expect(calls(log)).toHaveLength(2);
    expect(check.status).not.toBe("passed");
  });
});

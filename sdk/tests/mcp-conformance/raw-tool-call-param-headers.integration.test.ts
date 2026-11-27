/**
 * The hand-made tool calls against a real HTTP server that refuses a call
 * whose `Mcp-Param-Region` header is missing or wrong (HTTP 400, `-32020`).
 *
 * The server reads the header off the socket and logs every request, so the
 * assertions are about what reached it: the header on each call, and the
 * `tools/list` and second call that follow a refusal.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readJsonRpcBody, requestId } from "../support/json-rpc-fixture.js";
import {
  createRegionServer,
  REGION_TOOL,
  type RegionServerLog,
  type RegionServerOptions,
} from "../support/region-tool-server.js";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPConformanceConfig,
} from "../../src/mcp-conformance/index.js";

const MODERN = "2026-07-28" as const;
const OUTPUT_SCHEMA: MCPCheckId = "modern-tool-output-schema-conformant";
const PROBE = { toolName: REGION_TOOL, arguments: { region: "us-west1" } };
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serve(options: RegionServerOptions, log: RegionServerLog) {
  const answerFor = createRegionServer(options, log);
  const server = http.createServer((req, res) => {
    void (async () => {
      const parsed = await readJsonRpcBody(req, res);
      if (!parsed) return;
      const header = req.headers["mcp-param-region"];
      const { status, body } = answerFor({
        method: parsed.method ?? "",
        id: requestId(parsed),
        params: parsed.params as Record<string, unknown> | undefined,
        paramRegion: Array.isArray(header) ? header[0] : header,
      });
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${port}/mcp`;
}

async function run(
  options: RegionServerOptions,
  log: RegionServerLog,
  config: Partial<MCPConformanceConfig>
) {
  return await new MCPConformanceTest({
    serverUrl: await serve(options, log),
    protocolVersion: MODERN,
    checkTimeout: 5_000,
    readinessIds: [],
    ...config,
  }).run();
}

const calls = (log: RegionServerLog) =>
  log.filter((line) => line.startsWith("tools/call"));

describe("a tool with an x-mcp-header argument", () => {
  it("is called with the Mcp-Param header, and its check runs", async () => {
    const log: RegionServerLog = [];
    const result = await run({}, log, {
      checkIds: [OUTPUT_SCHEMA],
      fixtures: { toolCalls: [PROBE] },
    });

    const check = result.checks.find((entry) => entry.id === OUTPUT_SCHEMA);
    expect([check?.status, check?.error?.message]).toEqual([
      "passed",
      undefined,
    ]);
    expect(calls(log)).toEqual(["tools/call Mcp-Param-Region=us-west1"]);
  });

  it("gets the header on the log-level advice's call too", async () => {
    const log: RegionServerLog = [];
    await run({}, log, {
      // No check selected: only the advice calls the tool.
      checkIds: ["modern-no-session-id"],
      readinessIds: ["readiness-log-level-filtering"],
      logProbe: PROBE,
    });

    expect(calls(log)).toEqual(["tools/call Mcp-Param-Region=us-west1"]);
  });
});

describe("a server that refuses the call with HeaderMismatch", () => {
  it("is listed again and called once more, with the header it now asks for", async () => {
    const log: RegionServerLog = [];
    const result = await run({ listingsWithoutTheMark: 1 }, log, {
      checkIds: [OUTPUT_SCHEMA],
      fixtures: { toolCalls: [PROBE] },
    });

    expect(log.filter((line) => line !== "server/discover")).toEqual([
      "tools/list (without the mark)",
      "tools/call Mcp-Param-Region=(none)",
      "tools/list (with the mark)",
      "tools/call Mcp-Param-Region=us-west1",
    ]);
    expect(
      result.checks.find((entry) => entry.id === OUTPUT_SCHEMA)?.status
    ).toBe("passed");
  });

  it("is called twice at most, by the advice as well", async () => {
    const log: RegionServerLog = [];
    await run({ alwaysRefuse: true }, log, {
      checkIds: ["modern-no-session-id"],
      readinessIds: ["readiness-log-level-filtering"],
      logProbe: PROBE,
    });

    expect(calls(log)).toHaveLength(2);
    // A fresh listing sits between the two tries.
    const firstCall = log.findIndex((line) => line.startsWith("tools/call"));
    expect(log.slice(firstCall + 1, -1)).toEqual([
      "tools/list (with the mark)",
    ]);
  });
});

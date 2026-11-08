/**
 * Parity on a live fixture: one saved settings row, run the way the app runs
 * it (the request the Conformance page builds, through the web route's SDK
 * mapping) and the way a hosted start runs it (the executor), must call the
 * same tools with the same arguments, select the same checks with the same
 * skip reasons, and score the same.
 *
 * The row exercises a tool sent for a picked check, a saved tool whose check
 * is left out, a picked check with no tool saved (reported as not run for want
 * of input), and a protocol pin that filters a legacy-only check out.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  scoreFromProtocolResult,
  toConformanceReport,
  type ConformanceReport,
} from "@mcpjam/sdk";
import { createFixtureHandler } from "../../../../sdk/tests/support/dual-era-fixture.js";

const { createConvexClientMock } = vi.hoisted(() => ({
  createConvexClientMock: vi.fn(),
}));
vi.mock("../evals/route-helpers.js", () => ({
  createConvexClient: (...args: unknown[]) => createConvexClientMock(...args),
}));

import { runProtocolConformance } from "../../routes/shared/conformance.js";
import {
  decodeStoredProbes,
  protocolProbeFields,
  protocolRunOptions,
  runnableSelection,
  storedSelection,
  type ConformanceProbes,
} from "../../../shared/conformance-settings.js";
import { executePersistedConformanceRun } from "../conformance-run-executor.js";
import {
  readConformanceRunSettings,
  suitesKeptBySettings,
} from "../conformance-run-settings.js";

const PIN = "2026-07-28" as const;
const ROW = {
  serverId: "s1",
  defaultChecks: {
    protocol: [
      "tools-list",
      "server-initialize",
      "modern-tool-output-schema-conformant",
      "modern-logs-require-log-level",
    ],
    apps: [],
    tasks: [],
  },
  defaultAdvice: { protocolAdvice: [] },
  defaultInputs: {
    toolCallProbe: { toolName: "echo", arguments: '{"message":"graded"}' },
    inputRequiredProbe: { toolName: "echo", arguments: '{"message":"unused"}' },
  },
  updatedAt: 1,
};

type ToolCall = { name: unknown; arguments: unknown };
const toolCalls: ToolCall[] = [];
let httpServer: http.Server;
let url: string;

beforeAll(async () => {
  const fixture = createFixtureHandler();
  httpServer = http.createServer(
    toNodeHandler({
      fetch: async (request, options) => {
        if (request.method === "POST") {
          const body: unknown = await request
            .clone()
            .json()
            .catch(() => undefined); // Not JSON: nothing to record.
          for (const message of Array.isArray(body) ? body : [body]) {
            const rpc = message as {
              method?: string;
              params?: { name?: unknown; arguments?: unknown };
            } | null;
            if (rpc?.method === "tools/call") {
              toolCalls.push({
                name: rpc.params?.name,
                arguments: rpc.params?.arguments,
              });
            }
          }
        }
        return fixture.fetch(request, options);
      },
    }),
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("no address");
  url = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** What a run produced, without the timing that differs run to run. */
function summarize(report: ConformanceReport) {
  return {
    cases: report.groups
      .flatMap((group) => group.cases)
      .map((entry) => ({
        id: entry.id,
        status: entry.status,
        skipReason: entry.skipReason,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    score: {
      score: report.score?.score,
      applicable: report.score?.applicable,
      passed: report.score?.passed,
      failed: report.score?.failed,
      couldNotRun: report.score?.couldNotRun,
    },
  };
}

async function runAsTheAppDoes() {
  const probes = decodeStoredProbes(ROW.defaultInputs) as ConformanceProbes;
  const picked = runnableSelection(storedSelection(ROW), PIN);
  const options = protocolRunOptions(probes, picked, PIN);
  const { result } = await runProtocolConformance({
    serverUrl: url,
    protocolVersion: options.protocolVersion,
    checkIds: options.checkIds,
    readinessIds: options.readinessIds,
    ...protocolProbeFields(options.probes),
  });
  return {
    ...toConformanceReport(result),
    score: scoreFromProtocolResult(result),
  };
}

async function runAsAHostedStartDoes() {
  const reports = new Map<string, ConformanceReport>();
  const client = {
    query: vi.fn(async () => ROW),
    mutation: vi.fn(async (fn: string) => {
      if (fn === "conformanceRuns:startRun") return { runId: "run_1" };
      if (fn === "conformanceRuns:heartbeat") return { ok: true };
      return {};
    }),
    action: vi.fn(
      async (
        _fn: string,
        args: { suiteKind: string; report: ConformanceReport },
      ) => {
        reports.set(args.suiteKind, args.report);
      },
    ),
  };
  createConvexClientMock.mockReturnValue(client);
  const settings = await readConformanceRunSettings(client as never, {
    projectId: "p1",
    serverId: "s1",
    mode: "saved",
  });
  const suites = suitesKeptBySettings(
    ["protocol", "apps", "tasks"],
    settings,
    PIN,
  );
  await executePersistedConformanceRun({
    convexToken: "tok",
    projectId: "p1",
    server: { url } as never,
    suites,
    source: "api",
    target: { kind: "server", serverId: "s1" },
    protocolVersion: PIN,
    settings,
    runTimeoutSeconds: settings.runTimeoutSeconds,
  });
  return { suites, report: reports.get("protocol") };
}

describe("hosted runs and the app run the same saved settings the same way", () => {
  it("calls the same tools, selects the same checks and scores the same", async () => {
    toolCalls.length = 0;
    const app = await runAsTheAppDoes();
    const appCalls = [...toolCalls];

    toolCalls.length = 0;
    const hosted = await runAsAHostedStartDoes();
    const hostedCalls = [...toolCalls];

    // The suites the settings leave out are not part of the run.
    expect(hosted.suites).toEqual(["protocol"]);
    expect(hosted.report).toBeDefined();

    // Only the picked output-schema check's tool is called, with its saved
    // arguments; the saved tool of the unpicked check is never called.
    expect(appCalls).toContainEqual({
      name: "echo",
      arguments: { message: "graded" },
    });
    expect(appCalls).not.toContainEqual({
      name: "echo",
      arguments: { message: "unused" },
    });
    expect(hostedCalls).toEqual(appCalls);

    const appSummary = summarize(app);
    expect(summarize(hosted.report!)).toEqual(appSummary);

    const byId = new Map(appSummary.cases.map((entry) => [entry.id, entry]));
    // The pin keeps a legacy-only check out of the selection.
    expect(byId.has("server-initialize")).toBe(false);
    // A picked check with no tool saved is reported, not silently dropped.
    expect(byId.get("modern-logs-require-log-level")).toMatchObject({
      status: "skipped",
    });
  }, 120_000);
});

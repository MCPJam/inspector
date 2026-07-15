/**
 * Tests for the Stage 5 Step 3 host-config wire pickup in the eval reporter.
 *
 * Behavior under test:
 *  1. Reporter sends `{ hostConfig, hostConfigHash }` in one-shot `/report`
 *     body when a snapshot source is present (the v1 ingest surface always
 *     accepts the pair — the old per-baseUrl capability probe is gone).
 *  2. Reporter sends the wire pair in `/runs/start` body when the chunked
 *     path is taken.
 *  3. Reporter OMITS both fields when no snapshot source is available.
 *  4. Reporter OMITS both fields when iteration snapshots are heterogeneous
 *     (homogeneity gate fires — pass-1 behavior).
 *  5. `/runs/iterations` and `/runs/finalize` bodies NEVER contain the
 *     wire pair (per-run, not per-batch).
 *  6. Hash byte-equivalence: the hash the reporter sends matches what the
 *     backend would recompute by running
 *     `normalizeSdkEvalHostConfigForWire` + `computeHostConfigHashV2`.
 */

const sentryMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sentry", () => ({
  addBreadcrumb: sentryMocks.addBreadcrumb,
  captureEvalReportingFailure: sentryMocks.captureEvalReportingFailure,
}));

import { vi } from "vitest";
import { reportEvalResults } from "../src/report-eval-results";
import {
  computeHostConfigHashV2,
  normalizeSdkEvalHostConfigForWire,
} from "../src/host-config/internal";
import { Host } from "../src/host-config/index";
import type { HostJson } from "../src/host-config/index";
import type { EvalResultInput } from "../src/eval-reporting-types";

const successSummary = {
  total: 1,
  passed: 1,
  failed: 0,
  passRate: 1,
};

function okResponse(body: Record<string, unknown>): any {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ ok: true, ...body }),
  };
}

function makeHost(systemPrompt = "alpha"): Host {
  return new Host({
    style: "claude",
    model: "anthropic/claude-sonnet-4-6",
    systemPrompt,
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
  });
}

function smallResults(): EvalResultInput[] {
  return [{ caseTitle: "case-1", passed: true }];
}

/**
 * Build a chunked-path input: enough payload bytes to push
 * `shouldUseOneShotUpload` to false (the threshold is ~1MB). Padding via
 * `notes` keeps the result shape simple.
 */
function chunkedConfigOverrides(): {
  notes: string;
  expectedIterations: number;
} {
  return {
    notes: "x".repeat(1024 * 1024 * 2),
    expectedIterations: 1,
  };
}

function findRequestByUrl(
  fetchMock: ReturnType<typeof vi.fn>,
  needle: string
): { url: string; body: any } | undefined {
  for (const call of fetchMock.mock.calls) {
    const url = String(call[0]);
    if (url.endsWith(needle)) {
      const init = call[1] as { body?: string } | undefined;
      const body = init?.body ? JSON.parse(init.body) : undefined;
      return { url, body };
    }
  }
  return undefined;
}

describe("reportEvalResults — Stage 5 Step 3 wire host-config", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {});

  afterEach(() => {
    global.fetch = originalFetch;
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("sends {hostConfig, hostConfigHash} in one-shot /report when capability + explicitHost present", async () => {
    const host = makeHost("alpha");
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return okResponse({
        suiteId: "suite_1",
        runId: "run_1",
        status: "completed",
        result: "passed",
        summary: successSummary,
      });
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      host,
      results: smallResults(),
    });

    const report = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/report"
    );
    expect(report).toBeDefined();
    expect(report!.body.hostConfig).toBeDefined();
    expect(typeof report!.body.hostConfigHash).toBe("string");
    expect(report!.body.hostConfigHash.length).toBeGreaterThan(0);

    // Hash byte-equivalence with the backend's recompute pipeline.
    const expectedHash = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(host.toJSON())
    );
    expect(report!.body.hostConfigHash).toBe(expectedHash);

    // Runtime ids never appear on the wire.
    expect(report!.body.hostConfig.serverIds).toBeUndefined();
    expect(report!.body.hostConfig.optionalServerIds).toBeUndefined();
    expect(report!.body.hostConfig.serverConnectionOverrides).toBeUndefined();
  });

  it("sends wire pair in /runs/start when chunked path is taken", async () => {
    const host = makeHost();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/v1/projects/default/eval-ingest/runs/start")) {
        return okResponse({ suiteId: "s", runId: "r" });
      }
      if (u.endsWith("/api/v1/projects/default/eval-ingest/runs/iterations")) {
        return okResponse({ inserted: 1, skipped: 0, total: 1 });
      }
      if (u.endsWith("/api/v1/projects/default/eval-ingest/runs/finalize")) {
        return okResponse({
          suiteId: "s",
          runId: "r",
          status: "completed",
          result: "passed",
          summary: successSummary,
        });
      }
      throw new Error(`unexpected url ${u}`);
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      host,
      results: smallResults(),
      ...chunkedConfigOverrides(),
    });

    const start = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/runs/start"
    );
    expect(start).toBeDefined();
    expect(start!.body.hostConfig).toBeDefined();
    expect(typeof start!.body.hostConfigHash).toBe("string");

    // Critically: iterations + finalize MUST NOT carry the wire pair.
    const iters = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/runs/iterations"
    );
    expect(iters).toBeDefined();
    expect(iters!.body.hostConfig).toBeUndefined();
    expect(iters!.body.hostConfigHash).toBeUndefined();

    const finalize = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/runs/finalize"
    );
    expect(finalize).toBeDefined();
    expect(finalize!.body.hostConfig).toBeUndefined();
    expect(finalize!.body.hostConfigHash).toBeUndefined();
  });

  it("OMITS the wire pair when no snapshot source is available", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return okResponse({
        suiteId: "s",
        runId: "r",
        status: "completed",
        result: "passed",
        summary: successSummary,
      });
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      // No host, no executor, no per-iteration snapshot.
      results: smallResults(),
    });

    const report = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/report"
    );
    expect(report).toBeDefined();
    expect(report!.body.hostConfig).toBeUndefined();
    expect(report!.body.hostConfigHash).toBeUndefined();
  });

  it("OMITS the wire pair when per-iteration snapshots are heterogeneous", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return okResponse({
        suiteId: "s",
        runId: "r",
        status: "completed",
        result: "passed",
        summary: successSummary,
      });
    });
    global.fetch = fetchMock as any;

    const snapA: HostJson = makeHost("alpha").toJSON();
    const snapB: HostJson = makeHost("beta — different").toJSON();
    // The reporter consumes EvalResultInput; we attach hostSnapshot ad-hoc
    // because the homogeneity gate accepts a structural `hostSnapshot`
    // even though the public EvalResultInput type does not yet expose it.
    const results = [
      { caseTitle: "c1", passed: true, hostSnapshot: snapA } as any,
      { caseTitle: "c2", passed: true, hostSnapshot: snapB } as any,
    ];

    await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      // Explicit host present but heterogeneous iterations should win the
      // priority and trigger the omit.
      host: makeHost("fallback"),
      results,
    });

    const report = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/report"
    );
    expect(report).toBeDefined();
    expect(report!.body.hostConfig).toBeUndefined();
    expect(report!.body.hostConfigHash).toBeUndefined();
  });

  it("uses executor.getHostSnapshot as a fallback when no explicitHost", async () => {
    const host = makeHost("from-executor");
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return okResponse({
        suiteId: "s",
        runId: "r",
        status: "completed",
        result: "passed",
        summary: successSummary,
      });
    });
    global.fetch = fetchMock as any;

    await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      executor: { getHostSnapshot: () => host.toJSON() },
      results: smallResults(),
    });

    const report = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/report"
    );
    expect(report).toBeDefined();
    expect(report!.body.hostConfig).toBeDefined();
    const expectedHash = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(host.toJSON())
    );
    expect(report!.body.hostConfigHash).toBe(expectedHash);
  });

  it("fail-safe: a throwing executor.getHostSnapshot does NOT crash the report — wire pair is omitted with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      return okResponse({
        suiteId: "s",
        runId: "r",
        status: "completed",
        result: "passed",
        summary: successSummary,
      });
    });
    global.fetch = fetchMock as any;

    const result = await reportEvalResults({
      apiKey: "k",
      baseUrl: "https://example.com",
      suiteName: "S",
      executor: {
        getHostSnapshot: () => {
          throw new Error("boom: malformed snapshot");
        },
      },
      results: smallResults(),
    });

    expect(result.runId).toBeDefined();
    const report = findRequestByUrl(
      fetchMock,
      "/api/v1/projects/default/eval-ingest/report"
    );
    expect(report).toBeDefined();
    expect(report!.body.hostConfig).toBeUndefined();
    expect(report!.body.hostConfigHash).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("omitting hostConfig wire pair")
    );
    warn.mockRestore();
  });
});

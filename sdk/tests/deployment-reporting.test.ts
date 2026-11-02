import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results.js";
import {
  reportConformanceRun,
  reportConformanceRunSafely,
} from "../src/report-conformance-run.js";
import { buildConformanceRunReport } from "../src/conformance-run-types.js";

const evalInput = {
  suiteName: "suite",
  apiKey: "sk_test",
  results: [{ caseTitle: "case", passed: true }],
};

const conformanceReport = buildConformanceRunReport({
  requestedSuites: [],
  reports: {},
  startedAt: 0,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function conflictingEnv(): void {
  vi.stubEnv("MCPJAM_API_URL", "https://a.example.test/api/v1");
  vi.stubEnv("MCPJAM_BASE_URL", "https://b.example.test");
}

describe("reporting to a refused address", () => {
  it("throws a conflict from the Safely helper instead of warning", async () => {
    conflictingEnv();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(reportEvalResultsSafely(evalInput)).rejects.toMatchObject({
      code: "DEPLOYMENT_CONFLICT",
    });
    await expect(
      reportConformanceRunSafely(conformanceReport, { apiKey: "sk_test" })
    ).rejects.toMatchObject({ code: "DEPLOYMENT_CONFLICT" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a redirect from the ingest API without following it", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://b.example.test/collect" },
        })
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(
      reportEvalResults({ ...evalInput, baseUrl: "https://a.example.test" })
    ).rejects.toMatchObject({ code: "BACKEND_REDIRECT_REFUSED" });
    await expect(
      reportConformanceRun(conformanceReport, {
        apiKey: "sk_test",
        baseUrl: "https://a.example.test",
      })
    ).rejects.toMatchObject({ code: "BACKEND_REDIRECT_REFUSED" });
    for (const [url, init] of fetcher.mock.calls) {
      expect(url.startsWith("https://a.example.test/")).toBe(true);
      expect(init.redirect).toBe("manual");
    }
  });

  it("reports conformance to MCPJAM_API_URL with the caller's edge headers", async () => {
    vi.stubEnv("MCPJAM_API_URL", "https://a.example.test/api/v1");
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: new Headers(init.headers) });
        return Response.json({ runId: "run_1" });
      })
    );

    await reportConformanceRun(conformanceReport, {
      apiKey: "sk_test",
      headers: { "cf-access-client-id": "edge", authorization: "forged" },
    });
    expect(seen.map(({ url }) => url)).toEqual([
      "https://a.example.test/api/v1/projects/default/conformance-ingest/runs/start",
      "https://a.example.test/api/v1/projects/default/conformance-ingest/runs/finalize",
    ]);
    for (const { headers } of seen) {
      expect(headers.get("cf-access-client-id")).toBe("edge");
      expect(headers.get("authorization")).toBe("Bearer sk_test");
    }
  });
});

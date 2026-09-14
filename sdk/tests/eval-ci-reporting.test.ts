import { vi, beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results.js";
import { createEvalRunReporter } from "../src/eval-run-reporter.js";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import type { HostExecutor } from "../src/HostExecutor.js";
import { ciFixtures } from "./fixtures/eval-ci.js";

vi.mock("../src/sentry.js", () => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

const input = {
  apiKey: "sk_test_key",
  baseUrl: "https://ci-test.example.com",
  suiteName: "CI reporting",
  results: [{ caseTitle: "passes", passed: true }],
};

function response(url: string, count = 1): Response {
  return Response.json({
    ok: true,
    suiteId: "suite_ci",
    runId: "run_ci",
    status: url.endsWith("runs/start") ? "running" : "completed",
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    inserted: count,
    skipped: 0,
    total: count,
  });
}

function setCi(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

describe("CI metadata on SDK upload payloads", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("process", {
      ...process,
      env: { MCPJAM_GIT_AUTODETECT: "false" },
    });
    vi.stubEnv("MCPJAM_API_KEY", "sk_test_key");
    vi.stubEnv("MCPJAM_BASE_URL", input.baseUrl);
    fetchMock
      .mockReset()
      .mockImplementation(async (url, init) =>
        response(
          String(url),
          JSON.parse(String(init?.body ?? "{}")).results?.length ?? 0
        )
      );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function body(index = 0) {
    return JSON.parse(fetchMock.mock.calls[index][1]?.body as string);
  }

  it.each(ciFixtures)(
    "uploads $name CI details through direct reporting",
    async ({ env, expected }) => {
      setCi(env);
      await reportEvalResults(input);
      expect(body().ci).toEqual(expected);
      expect(input).not.toHaveProperty("ci");
    }
  );

  it.each(["suite", "test"])(
    "auto-saves %s CI details with no reporting configuration",
    async (kind) => {
      setCi(ciFixtures[0].env);
      const executor = {
        withOptions() {
          return this;
        },
        getPromptHistory: () => [],
        resetPromptHistory: () => {},
      } as unknown as HostExecutor;
      const test = new EvalTest({
        id: "c_ci_test",
        name: "passes",
        test: async () => true,
      });
      if (kind === "suite") {
        const suite = new EvalSuite({ name: "CI suite" });
        suite.add(test);
        await suite.run(executor, { iterations: 1 });
      } else {
        await test.run(executor, { iterations: 1 });
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body().ci).toEqual(ciFixtures[0].expected);
    }
  );

  it.each([
    {},
    { provider: "custom", commitSha: "c".repeat(40), branch: "custom" },
  ])(
    "preserves explicit CI %j in direct and incremental uploads",
    async (ci) => {
      setCi(ciFixtures[0].env);
      const options = Object.freeze({ ...input, ci: Object.freeze(ci) });
      await reportEvalResultsSafely(options);
      expect(body().ci).toEqual(
        Object.keys(ci).length ? { ...ciFixtures[0].expected, ...ci } : {}
      );
      const reporter = createEvalRunReporter(options);
      await reporter.flush();
      expect(body(1).ci).toEqual(
        Object.keys(ci).length ? { ...ciFixtures[0].expected, ...ci } : {}
      );
      await reporter.finalize();
      expect(options.ci).toEqual(ci);
    }
  );

  it("labels generic CI without guessing a specific provider", async () => {
    vi.stubEnv("CI", "true");
    await reportEvalResults(input);
    expect(body().ci).toEqual({ provider: "ci" });
  });

  it("attaches CI to chunked run creation", async () => {
    setCi(ciFixtures[1].env);
    await reportEvalResults({
      ...input,
      results: Array.from({ length: 201 }, (_, i) => ({
        caseTitle: `case-${i}`,
        passed: true,
      })),
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("runs/start");
    expect(body().ci).toEqual(ciFixtures[1].expected);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("runs/iterations")
      )
    ).toBe(true);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("runs/finalize");
  });

  it.each(["one-shot", "incremental"])(
    "freezes the reporter's CI before %s upload",
    async (mode) => {
      setCi(ciFixtures[0].env);
      const reporter = createEvalRunReporter(input);
      vi.stubEnv("GITHUB_SHA", "b".repeat(40));
      if (mode === "incremental") await reporter.flush();
      await reporter.finalize();
      expect(body().ci).toEqual(ciFixtures[0].expected);
    }
  );

  it("does not re-detect a reporter that was created outside CI", async () => {
    const reporter = createEvalRunReporter(input);
    setCi(ciFixtures[0].env);
    await reporter.finalize();
    expect(body().ci).toBeUndefined();
  });

  it("keeps the initial metadata when a direct upload retries", async () => {
    vi.useFakeTimers();
    setCi(ciFixtures[0].env);
    fetchMock.mockImplementationOnce(async () => {
      vi.stubEnv("GITHUB_SHA", "b".repeat(40));
      return Response.json({ ok: false, error: "temporary" }, { status: 503 });
    });
    const pending = reportEvalResults(input);
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body().ci).toEqual(ciFixtures[0].expected);
    expect(body(1).ci).toEqual(ciFixtures[0].expected);
  });
});

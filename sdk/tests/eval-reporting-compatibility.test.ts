import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { reportEvalResultsWithReceipt } from "../src/eval-reporting-receipt.js";
import { createEvalRunReporter } from "../src/eval-run-reporter.js";
import {
  unavailableCaseRunEvaluation,
  selectionStability,
} from "../src/run-evaluators.js";
import {
  normalizeReportingConfig,
  requiresRunMetadataCapability,
} from "../src/eval-reporting-config.js";

const git = vi.hoisted(() => vi.fn());
vi.mock("../src/eval-git.js", () => ({ detectEvalGitMetadata: git }));
vi.mock("../src/sentry.js", () => ({
  addBreadcrumb: vi.fn(),
  captureEvalReportingFailure: vi.fn(),
}));

const base = {
  apiKey: "key",
  suiteName: "compatibility",
  externalRunId: "invocation",
  baseUrl: "https://legacy.example",
};
const result = { caseTitle: "case", passed: true };
const report = {
  suiteId: "suite",
  runId: "run",
  status: "completed",
  result: "passed",
  summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
};
let requests: { url: string; body: Record<string, any> }[];

beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    env: { MCPJAM_GIT_AUTODETECT: "true" },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  git.mockResolvedValue({
    commitSha: "a".repeat(40),
    branch: "main",
    dirty: false,
  });
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/capabilities"))
        return Response.json({ error: "unknown route" }, { status: 404 });
      // A strict pre-expansion backend rejects the new fields, including dirty:false.
      if (
        body.runName !== undefined ||
        body.runTags !== undefined ||
        body.runMetadata !== undefined ||
        body.ci?.dirty !== undefined ||
        body.ci?.pullRequestNumber !== undefined
      )
        return Response.json({ error: "unknown field" }, { status: 400 });
      if (String(url).endsWith("runs/start"))
        return Response.json({
          ...report,
          status: "running",
          result: "pending",
        });
      if (String(url).endsWith("runs/iterations"))
        return Response.json({
          inserted: body.results.length,
          skipped: 0,
          total: body.results.length,
        });
      return Response.json(report);
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mixed-version eval reporting", () => {
  it.each([false, true])(
    "persists direct, chunked, and streaming evidence against a strict old backend with git dirty=%s",
    async (dirty) => {
      git.mockResolvedValue({
        dirty,
        branch: "main",
        commitSha: "a".repeat(40),
      });
      for (const count of [1, 201]) {
        const receipt = await reportEvalResultsWithReceipt({
          ...base,
          results: Array.from({ length: count }, () => result),
        });
        expect(receipt.state).toBe("persisted");
        expect(receipt.warnings).toMatchObject([
          { code: "RUN_METADATA_OMITTED" },
        ]);
      }
      const reporter = createEvalRunReporter({
        ...base,
        expectedIterations: 2,
      });
      reporter.add(result);
      await reporter.flush();
      reporter.add(result);
      const receipt = await reporter.finalizeWithReceipt();
      expect(receipt).toMatchObject({
        state: "persisted",
        acknowledgedIterations: 2,
        pendingIterations: 0,
      });
      expect(receipt.warnings).toMatchObject([
        { code: "RUN_METADATA_OMITTED" },
      ]);
      const starts = requests.filter(
        ({ url }) => url.endsWith("/report") || url.endsWith("runs/start")
      );
      expect(starts).toHaveLength(3);
      for (const { body } of starts) {
        expect(body.ci).toEqual({ branch: "main", commitSha: "a".repeat(40) });
        expect(body).not.toHaveProperty("warnings");
      }
    }
  );

  it("does not require a capability for an empty runTags array", () => {
    const normalized = normalizeReportingConfig({ runTags: [], ci: {} }, {});
    expect(normalized.runTags).toBeUndefined();
    expect(requiresRunMetadataCapability(normalized)).toBe(false);
    expect(requiresRunMetadataCapability({ runTags: [] })).toBe(false);
  });

  it("keeps core persistence and explicit warnings when optional metadata and advisories are disabled", async () => {
    const evaluation = unavailableCaseRunEvaluation([selectionStability()], {
      caseId: "case",
      sourceConfigHash: "source",
      iterationIds: ["iteration"],
    });
    const receipt = await reportEvalResultsWithReceipt({
      ...base,
      strict: true,
      runName: "name",
      runTags: ["tag"],
      runMetadata: { build: 1 },
      ci: { dirty: true, pullRequestNumber: 12 },
      runEvaluations: [evaluation],
      results: [result],
    });
    expect(receipt).toMatchObject({
      state: "persisted",
      acknowledgedIterations: 1,
    });
    expect(receipt.warnings?.map((w) => w.code)).toEqual([
      "RUN_METADATA_OMITTED",
      "RUN_EVALUATIONS_OMITTED",
    ]);
    expect(requests.some(({ url }) => url.endsWith("runs/evaluations"))).toBe(
      false
    );
    expect(evaluation.results).toHaveLength(1);
  });

  it("does not turn an acknowledged core run into failure when advisory persistence fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/capabilities"))
          return Response.json({
            capabilities: { evalsRunMetadata: 1, evalsRunEvaluations: 1 },
          });
        if (String(url).endsWith("runs/evaluations"))
          return Response.json({ error: "secret-canary" }, { status: 400 });
        return Response.json(report);
      })
    );
    const evaluation = unavailableCaseRunEvaluation([selectionStability()], {
      caseId: "case",
      sourceConfigHash: "source",
      iterationIds: ["iteration"],
    });
    const receipt = await reportEvalResultsWithReceipt({
      ...base,
      strict: true,
      runEvaluations: [evaluation],
      results: [result],
    });
    expect(receipt.state).toBe("persisted");
    expect(receipt.warnings).toMatchObject([
      { code: "RUN_EVALUATIONS_NOT_CONFIRMED" },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("secret-canary");
  });
  it("retries a validation refusal once without optional fields while preserving identity, evidence and policy", async () => {
    const attempts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("capabilities"))
          return Response.json({ capabilities: { evalsRunMetadata: 1 } });
        const body = JSON.parse(String(init?.body));
        attempts.push(body);
        if (body.ci?.dirty !== undefined)
          return Response.json(
            { error: "unknown field dirty" },
            { status: 400 }
          );
        return Response.json(report);
      })
    );
    const receipt = await reportEvalResultsWithReceipt({
      ...base,
      results: [result],
      passCriteria: { minimumPassRate: 100 },
    });
    expect(receipt.state).toBe("persisted");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      externalRunId: attempts[0].externalRunId,
      results: attempts[0].results,
      passCriteria: attempts[0].passCriteria,
    });
    expect(attempts[1].ci).not.toHaveProperty("dirty");
    expect(receipt.warnings).toMatchObject([{ code: "RUN_METADATA_OMITTED" }]);
  });
});

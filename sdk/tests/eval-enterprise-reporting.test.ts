import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeReportingConfig,
  buildReportingBody,
  REPORTING_CONFIG_FIELDS,
} from "../src/eval-reporting-config.js";
import { reportEvalResultsWithReceipt } from "../src/eval-reporting-receipt.js";
import { EvalTest } from "../src/EvalTest.js";
import { EvalSuite } from "../src/EvalSuite.js";
import { evalTestVariants } from "../src/eval-variants.js";
import { evaluateGates, gateInputFromSuiteResult } from "../src/gates.js";
import type { HostExecutor } from "../src/HostExecutor.js";
const executor = (): HostExecutor =>
  ({
    withOptions: () => executor(),
    getPromptHistory: () => [],
    resetPromptHistory: () => {},
  }) as unknown as HostExecutor;
beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    env: { MCPJAM_GIT_AUTODETECT: "false" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("enterprise reporting contracts", () => {
  it("classifies every field and excludes local credentials and controls", () => {
    const input = Object.fromEntries(
      Object.keys(REPORTING_CONFIG_FIELDS).map((key) => [key, key])
    );
    const body = buildReportingBody(input);
    for (const [key, boundary] of Object.entries(REPORTING_CONFIG_FIELDS))
      expect(key in body).toBe(boundary === "wire");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });
  it("normalizes metadata with explicit precedence and bounded flat values", () => {
    expect(
      normalizeReportingConfig(
        { runName: "explicit", runTags: ["a"], runMetadata: { x: 1 } },
        {
          MCPJAM_RUN_NAME: "env",
          MCPJAM_RUN_TAGS: "a, b",
          MCPJAM_RUN_METADATA: '{"y":2}',
        }
      )
    ).toMatchObject({
      runName: "explicit",
      runTags: ["a", "b"],
      runMetadata: { x: 1 },
    });
    for (const runMetadata of [
      { x: NaN },
      { x: {} },
      JSON.parse('{"__proto__":"x"}'),
    ])
      expect(() =>
        normalizeReportingConfig({ runMetadata } as never, {})
      ).toThrow();
  });
  it("distinguishes disabled, missing key and failed persistence without leaking errors", async () => {
    vi.stubEnv("MCPJAM_API_KEY", "");
    const input = {
      suiteName: "test",
      results: [{ caseTitle: "a", passed: true }],
    };
    expect(
      (await reportEvalResultsWithReceipt({ ...input, enabled: false })).reason
    ).toBe("disabled");
    expect((await reportEvalResultsWithReceipt(input)).reason).toBe(
      "missing_api_key"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret-api-key", { status: 401 }))
    );
    const receipt = await reportEvalResultsWithReceipt({
      ...input,
      apiKey: "secret-api-key",
    });
    expect(receipt).toMatchObject({
      state: "failed",
      acknowledgedIterations: null,
      pendingIterations: null,
    });
    expect(JSON.stringify(receipt)).not.toContain("secret-api-key");
  });
  it("freezes selected coverage, inherits defaults, and refuses a full-suite gate", async () => {
    const suite = new EvalSuite({
      name: "source",
      defaults: { iterations: 2 },
      mcpjam: { enabled: false },
    });
    for (const id of ["a", "b"])
      suite.add(new EvalTest({ id, name: id, execute: async () => {} }));
    const selected = suite.subset(["b"]);
    const result = await selected.run(executor());
    expect(suite.getAll()).toHaveLength(2);
    expect(suite.get("b")?.getResults()).toBeNull();
    expect(result.selection).toMatchObject({
      sourceCaseIds: ["a", "b"],
      selectedCaseIds: ["b"],
      scope: "selected",
    });
    expect(result.aggregate.iterations).toBe(2);
    expect(() =>
      evaluateGates(gateInputFromSuiteResult(result), { minimumPassRate: 1 })
    ).toThrow("Incomplete suite selection");
    expect(() =>
      evaluateGates(gateInputFromSuiteResult(result), {
        minimumPassRate: 1,
        selectionScope: "selected",
      })
    ).not.toThrow();
    expect(() => suite.subset(["missing"])).toThrow();
  });
  it("variants preserve declared IDs across rename and reorder and validate before factories", () => {
    const factory = vi.fn((entry) => ({
      name: entry.label ?? entry.id,
      execute: async () => {},
    }));
    const entries = [
      { id: "a", phrasing: "one" },
      { id: "b", phrasing: "two" },
    ];
    expect(
      evalTestVariants(entries, factory).map((test) => test.getId())
    ).toEqual(["a", "b"]);
    expect(
      evalTestVariants(
        [...entries]
          .reverse()
          .map((entry) => ({ ...entry, label: "label" + entry.id })),
        factory
      ).map((test) => test.getId())
    ).toEqual(["b", "a"]);
    factory.mockClear();
    expect(() => evalTestVariants([entries[0], entries[0]], factory)).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("reporting entry-point parity", () => {
  const hosted = {
    suiteId: "suite",
    runId: "run",
    projectId: "project",
    status: "completed",
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
  };
  it("snapshots accepted evidence before the first asynchronous boundary", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json(hosted);
      })
    );
    const results = [{ caseTitle: "original", passed: true }];
    const promise = reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "suite",
      results,
      ci: {},
    });
    results[0].caseTitle = "mutated";
    results.push({ caseTitle: "extra", passed: false });
    expect((await promise).acceptedIterations).toBe(1);
    expect(calls[0].results).toMatchObject([
      { caseTitle: "original", passed: true },
    ]);
  });
  it("clears a prior hosted report while preserving a second run's local results", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(hosted))
        .mockResolvedValueOnce(
          Response.json({ message: "denied" }, { status: 401 })
        )
    );
    const test = new EvalTest({
      id: "case",
      name: "case",
      execute: async () => {},
    });
    const options = { iterations: 1, mcpjam: { apiKey: "key", ci: {} } };
    await test.run(executor(), options);
    expect(test.getLastReport()?.runId).toBe("run");
    await test.run(executor(), options);
    expect(test.getLastReport()).toBeNull();
    expect(test.getResults()?.successes).toBe(1);
    expect(test.getReportingReceipt().state).toBe("failed");
  });
  it("forwards run metadata, suite tags, project and policy on all producer paths", async () => {
    const { reportEvalResults } = await import("../src/report-eval-results.js");
    const { createEvalRunReporter } =
      await import("../src/eval-run-reporter.js");
    const bodies: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push({ url: String(url), body });
        if (String(url).endsWith("capabilities"))
          return Response.json({
            ok: true,
            capabilities: { evalsRunMetadata: 1 },
          });
        if (String(url).endsWith("runs/start"))
          return Response.json({
            ...hosted,
            status: "running",
            result: "pending",
          });
        if (String(url).endsWith("runs/iterations"))
          return Response.json({
            inserted: body.results.length,
            skipped: 0,
            total: body.results.length,
          });
        return Response.json(hosted);
      })
    );
    const config = {
      apiKey: "key",
      suiteName: "same",
      project: "project",
      tags: ["suite-tag"],
      runTags: ["run-tag"],
      runName: "release",
      runMetadata: { build: 7 },
      framework: "custom",
      ci: { provider: "custom" },
      expectedIterations: 1,
      passCriteria: { minimumPassRate: 100 },
    };
    const results = [{ caseTitle: "case", passed: true }];
    await reportEvalResults({ ...config, results });
    const test = new EvalTest({
      id: "case",
      name: "case",
      execute: async () => {},
    });
    await test.run(executor(), { iterations: 1, mcpjam: config });
    const suite = new EvalSuite({ name: "same", mcpjam: config });
    suite.add(
      new EvalTest({ id: "case", name: "case", execute: async () => {} })
    );
    await suite.run(executor(), { iterations: 1 });
    const reporter = createEvalRunReporter(config);
    reporter.add(results[0]);
    await reporter.flush();
    await reporter.finalizeWithReceipt();
    const starts = bodies.filter(
      ({ url }) => url.endsWith("/report") || url.endsWith("runs/start")
    );
    expect(starts).toHaveLength(4);
    for (const { url, body } of starts) {
      expect(url).toContain("/projects/project/");
      for (const key of [
        "suiteName",
        "tags",
        "runTags",
        "runName",
        "runMetadata",
        "framework",
        "ci",
        "expectedIterations",
        "passCriteria",
      ] as const)
        expect(body[key]).toEqual(config[key]);
    }
  });
});

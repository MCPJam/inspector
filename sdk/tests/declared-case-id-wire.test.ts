/**
 * The declared case id ON THE WIRE.
 *
 * W0.1a made `EvalTestConfig.id` required but changed no payload byte; this is
 * the step that puts it in the upload. The load-bearing assertions here are
 * therefore made against the SERIALIZED request body, not against the in-memory
 * result objects — "the field reaches the backend" is the claim, and a mapper
 * that builds it correctly into an object nobody sends proves nothing.
 */
const sentryMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn().mockResolvedValue(undefined),
  captureEvalReportingFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sentry", () => ({
  addBreadcrumb: sentryMocks.addBreadcrumb,
  captureEvalReportingFailure: sentryMocks.captureEvalReportingFailure,
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalSuite } from "../src/EvalSuite";
import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import { evalTestFromPlatformCase } from "../src/corpus";
import {
  iterationsToEvalResultInputs,
  promptsToEvalResult,
  runToEvalResults,
  suiteRunToEvalResults,
} from "../src/eval-result-mapping";
import {
  reportEvalResults,
  reportEvalResultsSafely,
} from "../src/report-eval-results";
import { EvalReportingError } from "../src/errors";
import type { EvalResultInput } from "../src/eval-reporting-types";
import type { HostRunner } from "../src/HostRunner";
import type { PlatformEvalCase } from "../src/platform/types";

const BASE_URL = "https://backend.test";

function mockPromptResult(prompt: string): PromptResult {
  return PromptResult.from({
    prompt,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: "ok" },
    ],
    text: "ok",
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    latency: { e2eMs: 10, llmMs: 8, mcpMs: 2 },
  });
}

/** Minimal executor: no `getHostSnapshot`, so no capability probe fires. */
function mockAgent(): HostRunner {
  const create = (): HostRunner => {
    let history: PromptResult[] = [];
    return {
      run: async (message: string) => {
        const result = mockPromptResult(message);
        history.push(result);
        return result;
      },
      resetPromptHistory: () => {
        history = [];
      },
      getPromptHistory: () => [...history],
      withOptions: () => create(),
    } as unknown as HostRunner;
  };
  return create();
}

function okResponse(): any {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      ok: true,
      suiteId: "suite_1",
      runId: "run_1",
      status: "completed",
      result: "passed",
      summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    }),
  };
}

/** The results array exactly as it was serialized onto the request body. */
function uploadedResults(fetchMock: ReturnType<typeof vi.fn>): any[] {
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  return body.results;
}

async function runSuiteAndCapture(suite: EvalSuite): Promise<any[]> {
  const fetchMock = vi.fn().mockResolvedValue(okResponse());
  global.fetch = fetchMock as any;
  await suite.run(mockAgent(), {
    iterations: 1,
    mcpjam: { apiKey: "sk_test_key", baseUrl: BASE_URL },
  });
  expect(fetchMock).toHaveBeenCalled();
  return uploadedResults(fetchMock);
}

describe("declared case id on the upload", () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.MCPJAM_BASE_URL;
  const originalApiKey = process.env.MCPJAM_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.MCPJAM_BASE_URL;
    else process.env.MCPJAM_BASE_URL = originalBaseUrl;
    if (originalApiKey === undefined) delete process.env.MCPJAM_API_KEY;
    else process.env.MCPJAM_API_KEY = originalApiKey;
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("serializes `caseId` from the config onto every result", async () => {
    const suite = new EvalSuite({ name: "wire" });
    suite.add(
      new EvalTest({
        id: "c_refund_flow",
        name: "refund flow",
        test: async (executor) => {
          await executor.run("ask for a refund");
          return true;
        },
      })
    );

    const results = await runSuiteAndCapture(suite);

    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("c_refund_flow");
    // The whole point of the field: the id survives a rename of the display
    // name, which the title does not.
    expect(results[0].caseTitle).toBe("refund flow");
  });

  it("serializes `caseId` from a standalone EvalTest run too", async () => {
    // `EvalTest.run()` with reporting enabled uploads through its OWN identity
    // object, not the suite's. A renamed standalone test would keep forking its
    // history if only the suite path carried the id.
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as any;

    const test = new EvalTest({
      id: "c_standalone",
      name: "standalone case",
      test: async (executor) => {
        await executor.run("go");
        return true;
      },
    });
    await test.run(mockAgent(), {
      iterations: 1,
      mcpjam: { apiKey: "sk_test_key", baseUrl: BASE_URL },
    });

    const [result] = uploadedResults(fetchMock);
    expect(result.caseId).toBe("c_standalone");
    expect(result.caseTitle).toBe("standalone case");
  });

  it("emits caseId === externalCaseId for a hosted corpus case", () => {
    // `loadCorpus` satisfies the equality rule by construction — it declares
    // the hosted case's own id in BOTH fields. Verified rather than assumed,
    // because a drift here throws at construction for every corpus user.
    const platformCase: PlatformEvalCase = {
      id: "case_hosted_1",
      title: "Refund flow",
      steps: [{ id: "s1", kind: "prompt", prompt: "Ask for a refund" }],
      iterations: 1,
      isNegative: false,
      models: [{ provider: "openai", model: "gpt-4o" } as never],
      createdAt: 1,
      updatedAt: 2,
    };
    const test = evalTestFromPlatformCase(platformCase);
    const config = test.getConfig();

    expect(config.id).toBe("case_hosted_1");
    expect(config.externalCaseId).toBe("case_hosted_1");

    const [result] = iterationsToEvalResultInputs(
      config.name ?? "",
      [
        {
          passed: true,
          prompts: [mockPromptResult("Ask for a refund")],
          latencies: [{ e2eMs: 10, llmMs: 8, mcpMs: 2 }],
          tokens: { input: 5, output: 5, total: 10 },
        } as never,
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { caseId: config.id, externalCaseId: config.externalCaseId }
    );
    expect(result.caseId).toBe("case_hosted_1");
    expect(result.externalCaseId).toBe("case_hosted_1");
  });

  it("adds caseId and changes nothing else about a legacy payload", async () => {
    // Diffed, not eyeballed: the same iteration is mapped twice, once with a
    // declared identity and once with none, and the two payloads must differ
    // in exactly one key.
    const iterations = [
      {
        passed: true,
        prompts: [mockPromptResult("hello")],
        latencies: [{ e2eMs: 10, llmMs: 8, mcpMs: 2 }],
        tokens: { input: 5, output: 5, total: 10 },
        retryCount: 0,
      } as never,
    ];
    const mapArgs = [
      "legacy case",
      iterations,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ] as const;

    const legacy = JSON.parse(
      JSON.stringify(iterationsToEvalResultInputs(...mapArgs))
    );
    const declared = JSON.parse(
      JSON.stringify(
        iterationsToEvalResultInputs(...mapArgs, { caseId: "c_legacy" })
      )
    );

    expect(declared).toHaveLength(1);
    expect(declared[0].caseId).toBe("c_legacy");
    const { caseId: _dropped, ...withoutCaseId } = declared[0];
    expect(withoutCaseId).toEqual(legacy[0]);

    // And on the wire, a config with no `externalCaseId` gains `caseId` and
    // `intent` and no other key.
    //
    // `intent` is the second deliberate addition, and it is present here while
    // ABSENT from the bare-mapper payload above on purpose: a suite-driven
    // upload is an authoritative reporter, so a case with no label says so
    // explicitly (`intent: null`) rather than staying silent. A bare
    // `iterationsToEvalResultInputs` call with no identity does not speak to
    // intent at all, which is what preserves a label set elsewhere.
    const suite = new EvalSuite({ name: "legacy" });
    suite.add(
      new EvalTest({
        id: "c_legacy",
        name: "legacy case",
        test: async (executor) => {
          await executor.run("hello");
          return true;
        },
      })
    );
    const [uploaded] = await runSuiteAndCapture(suite);
    expect(uploaded.caseId).toBe("c_legacy");
    // `externalIterationId` is stamped on by the reporter, not the mapper.
    expect(uploaded.intent).toBeNull();
    const {
      caseId: _uploadedId,
      intent: _uploadedIntent,
      externalIterationId,
      ...uploadedMapped
    } = uploaded;
    expect(typeof externalIterationId).toBe("string");
    expect(Object.keys(uploadedMapped).sort()).toEqual(
      Object.keys(legacy[0]).sort()
    );
  });

  it("keeps per-test identity when no test declares an externalCaseId", async () => {
    // `caseIdentityByTest` used to be sparse — populated only for tests that
    // set one of the three optional identity fields — and a required `id`
    // makes it dense. Every reader keys it by test NAME, so the change is
    // safe; this is the guard that says so.
    const suite = new EvalSuite({ name: "dense" });
    suite.add(
      new EvalTest({
        id: "c_first",
        name: "first",
        test: async (executor) => {
          await executor.run("one");
          return true;
        },
      })
    );
    suite.add(
      new EvalTest({
        id: "c_second",
        name: "second",
        test: async (executor) => {
          await executor.run("two");
          return false;
        },
      })
    );

    const results = await runSuiteAndCapture(suite);

    expect(
      results.map((result) => [result.caseTitle, result.caseId, result.passed])
    ).toEqual([
      ["first", "c_first", true],
      ["second", "c_second", false],
    ]);
    for (const result of results) {
      expect(result.externalCaseId).toBeUndefined();
    }
  });

  it("forwards caseId through the run-conversion helpers when asked", () => {
    // These helpers carry no identity of their own — they receive a
    // `casePrefix`, not an `EvalTest` — so `caseId` is offered and never
    // defaulted. A caller who wants a run's iterations joined to one declared
    // case can now say so; one who says nothing gets exactly what they got
    // before.
    const iteration = {
      passed: true,
      prompts: [mockPromptResult("hello")],
      latencies: [{ e2eMs: 10, llmMs: 8, mcpMs: 2 }],
      tokens: { input: 5, output: 5, total: 10 },
      retryCount: 0,
    } as never;
    const run = { iterationDetails: [iteration, iteration] } as never;

    const declared = runToEvalResults(run, {
      casePrefix: "run",
      caseId: "c_run",
    });
    expect(declared.map((result) => result.caseId)).toEqual(["c_run", "c_run"]);
    // The `-iter-N` suffix is what makes each iteration its own hosted case, so
    // declaring one id drops it: the backend titles a grouped case from the
    // first result it accepts, and keeping the suffix would leave a case that
    // holds both iterations named "run-iter-1".
    expect(declared.map((result) => result.caseTitle)).toEqual(["run", "run"]);
    // The iteration number is not lost — it rides the metadata, as it did
    // before this option existed.
    expect(declared.map((result) => result.metadata?.iterationNumber)).toEqual([
      1, 2,
    ]);
    // And without an id, the per-iteration titles are exactly as they were.
    expect(
      runToEvalResults(run, { casePrefix: "run" }).map(
        (result) => result.caseTitle
      )
    ).toEqual(["run-iter-1", "run-iter-2"]);

    const suite = suiteRunToEvalResults(
      new Map([
        ["first", run],
        ["second", run],
      ]),
      { casePrefix: "s", caseIdByTest: { first: "c_first" } }
    );
    expect(suite.map((result) => result.caseId)).toEqual([
      "c_first",
      "c_first",
      undefined,
      undefined,
    ]);
  });

  it("leaves the run-conversion payload byte-identical when no caseId is given", () => {
    // The additive guarantee, diffed rather than asserted by eye: a caller who
    // passes nothing must get the pre-change payload back, key for key.
    const iteration = {
      passed: true,
      prompts: [mockPromptResult("hello")],
      latencies: [{ e2eMs: 10, llmMs: 8, mcpMs: 2 }],
      tokens: { input: 5, output: 5, total: 10 },
      retryCount: 0,
    } as never;
    const run = { iterationDetails: [iteration] } as never;

    const bare = JSON.parse(
      JSON.stringify(runToEvalResults(run, { casePrefix: "run" }))
    );
    const declared = JSON.parse(
      JSON.stringify(
        runToEvalResults(run, { casePrefix: "run", caseId: "c_run" })
      )
    );

    expect(bare[0].caseId).toBeUndefined();
    expect("caseId" in bare[0]).toBe(false);

    // Declaring an id changes exactly two keys and no others: `caseId` is
    // added, and `caseTitle` loses the `-iter-N` suffix because the id says
    // these iterations are one case rather than one case each.
    const {
      caseId: _dropped,
      caseTitle: declaredTitle,
      ...declaredRest
    } = declared[0];
    const { caseTitle: bareTitle, ...bareRest } = bare[0];
    expect(declaredRest).toEqual(bareRest);
    expect(bareTitle).toBe("run-iter-1");
    expect(declaredTitle).toBe("run");
  });

  it("forwards caseId through the low-level prompt mappers", () => {
    const prompt = mockPromptResult("hello");

    const withId = promptsToEvalResult([prompt], {
      caseTitle: "case",
      passed: true,
      caseId: "c_prompts",
    });
    expect(withId.caseId).toBe("c_prompts");

    const withoutId = promptsToEvalResult([prompt], {
      caseTitle: "case",
      passed: true,
    });
    expect(withoutId.caseId).toBeUndefined();
    expect(JSON.stringify(withoutId)).not.toContain("caseId");

    const single = prompt.toEvalResult({
      caseTitle: "case",
      caseId: "c_single",
    });
    expect(single.caseId).toBe("c_single");
    expect(prompt.toEvalResult({ caseTitle: "case" }).caseId).toBeUndefined();
    expect(
      JSON.stringify(prompt.toEvalResult({ caseTitle: "case" }))
    ).not.toContain("caseId");
  });
});

describe("a reporting backend that does not understand caseId", () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.MCPJAM_BASE_URL;

  // What a Convex validator predating W0.1b hands back. Strict argument
  // validation refuses the WHOLE upload rather than stripping the field, so
  // this is a rejection with nothing filed — not a partial write.
  const ARGUMENT_VALIDATION_ERROR =
    "ArgumentValidationError: Object contains extra field `caseId` that is " +
    'not in the validator.\n\nObject: {caseTitle: "refund flow"}\n' +
    "Validator: v.object({caseTitle: v.string()})";

  function rejectingFetch(status: number) {
    return vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: "Internal Server Error",
      json: async () => ({ ok: false, error: ARGUMENT_VALIDATION_ERROR }),
    });
  }

  const input = {
    apiKey: "sk_test_key",
    baseUrl: BASE_URL,
    suiteName: "compat",
    results: [
      { caseTitle: "refund flow", passed: true, caseId: "c_refund" },
    ] as EvalResultInput[],
  };

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.MCPJAM_BASE_URL;
    else process.env.MCPJAM_BASE_URL = originalBaseUrl;
    sentryMocks.addBreadcrumb.mockClear();
    sentryMocks.captureEvalReportingFailure.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces an actionable upgrade error, not a validator dump", async () => {
    global.fetch = rejectingFetch(500) as any;

    const error = await reportEvalResults(input).then(
      () => null,
      (thrown) => thrown
    );

    expect(error).toBeInstanceOf(EvalReportingError);
    expect((error as EvalReportingError).isReportingBackendIncompatible).toBe(
      true
    );
    const message = (error as Error).message;
    expect(message).toContain("older than this SDK requires");
    // Names the field, what was lost, and where the fix lives.
    expect(message).toContain("caseId");
    expect(message).toContain("no results were filed");
    expect(message).toContain("baseUrl");
    // A reporting failure, said in those words — never a verdict on the run.
    expect(message).toContain("not an eval verdict");
    // The backend's own words survive: they name the endpoint and the field.
    expect(message).toContain("ArgumentValidationError");
  });

  it("does not retry a rejection no retry can fix", async () => {
    // 500 is normally retried three times with backoff. A strict validator
    // will refuse the identical payload every time, so the retries only delay
    // the message the author needs to read.
    const fetchMock = rejectingFetch(500);
    global.fetch = fetchMock as any;

    await expect(reportEvalResults(input)).rejects.toThrow(
      /older than this SDK requires/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays a warning and a null result through the safe entry point", async () => {
    global.fetch = rejectingFetch(500) as any;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(reportEvalResultsSafely(input)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const warning = warn.mock.calls[0][0] as string;
    expect(warning).toContain("eval reporting failed");
    expect(warning).toContain("older than this SDK requires");
    // The run's own verdicts are untouched — nothing here reports a failure.
    expect(input.results[0].passed).toBe(true);
  });

  it("still throws from the safe entry point under strict", async () => {
    global.fetch = rejectingFetch(500) as any;

    await expect(
      reportEvalResultsSafely({ ...input, strict: true })
    ).rejects.toThrow(/older than this SDK requires/);
  });

  it("does not claim incompatibility when a DIFFERENT field was rejected", async () => {
    // The validator refuses `metadata` and echoes the rejected object back —
    // and that echo contains `caseId`. Answering this with "upgrade your
    // backend, it does not know caseId" would send the author to fix a field
    // the backend accepted, and would suppress a retry this may deserve.
    const otherField =
      "ArgumentValidationError: Object contains extra field `metadata` that " +
      'is not in the validator.\n\nObject: {caseTitle: "refund flow", ' +
      'caseId: "c_refund", metadata: {run: 1}}\n' +
      "Validator: v.object({caseTitle: v.string(), caseId: v.optional(v.string())})";
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ ok: false, error: otherField }),
    }) as any;

    const error = await reportEvalResults(input).then(
      () => null,
      (thrown) => thrown
    );

    expect((error as EvalReportingError).isReportingBackendIncompatible).toBe(
      false
    );
    expect((error as Error).message).toBe(otherField);
    expect((error as Error).message).not.toContain(
      "older than this SDK requires"
    );
  });

  it("leaves a backend that DOES understand caseId to speak for itself", async () => {
    // An invalid-id or conflicting-identity rejection is a content error the
    // author must read as written; rewriting it as "upgrade your backend"
    // would send them to fix the wrong thing.
    const conflict =
      'Conflicting case identity for "refund flow": caseId "c_a" and ' +
      'externalCaseId "c_b" are two different claims about which case this is.';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ ok: false, error: conflict }),
    }) as any;

    const error = await reportEvalResults(input).then(
      () => null,
      (thrown) => thrown
    );

    expect((error as EvalReportingError).isReportingBackendIncompatible).toBe(
      false
    );
    expect((error as Error).message).toBe(conflict);
  });
});

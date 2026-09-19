import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { reportEvalResultsWithReceipt } from "../src/eval-reporting-receipt.js";

vi.mock("../src/eval-git.js", () => ({
  detectEvalGitMetadata: vi.fn(async () => undefined),
}));
vi.mock("../src/sentry.js", () => ({
  addBreadcrumb: vi.fn(),
  captureEvalReportingFailure: vi.fn(),
}));

/**
 * The PRIMARY iteration payload is the one almost every run sends, and it
 * carries each iteration's `evaluationConfig` through `scoreMetadata`. A target
 * that has not deployed the canonical spelling refuses a `required` role there
 * — and the refusal does not fail the upload, it quarantines every iteration as
 * `score_integrity_invalid`, so the dashboard shows an EMPTY run rather than a
 * broken one. That is why this projection cannot live only on the optional
 * `/runs/evaluations` path.
 */
const report = {
  suiteId: "suite",
  runId: "run",
  status: "completed",
  result: "passed",
  summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
};

function resultWithRequiredScorer() {
  return {
    caseTitle: "case",
    passed: true,
    metadata: {
      scores: [{ scorerId: "s1", status: "passed" }],
      evaluationConfig: {
        definitions: [
          { scorerId: "s1", role: "required", kind: "assertion" },
          { scorerId: "s2", role: "advisory", kind: "assertion" },
        ],
      },
    },
  };
}

let requests: { url: string; body: Record<string, any> }[];

function stubTarget(capabilities: Record<string, unknown> | null) {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/capabilities")) {
        return capabilities === null
          ? Response.json({ error: "unknown route" }, { status: 404 })
          : Response.json({ capabilities });
      }
      if (String(url).endsWith("runs/iterations"))
        return Response.json({
          inserted: body.results.length,
          skipped: 0,
          total: body.results.length,
        });
      if (String(url).endsWith("runs/start"))
        return Response.json({
          ...report,
          status: "running",
          result: "pending",
        });
      return Response.json(report);
    })
  );
}

/** Every role embedded in a primary-payload request body. */
function rolesSent() {
  return requests
    .filter((r) => !r.url.endsWith("/capabilities"))
    .flatMap((r) => (r.body.results ?? []) as any[])
    .flatMap(
      (result) =>
        (result?.metadata?.evaluationConfig?.definitions ?? []) as any[]
    )
    .map((definition) => definition.role);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the policy role sent in the primary iteration payload", () => {
  it("preserves nullish definitions while converting valid roles", async () => {
    stubTarget({ evalsRunMetadata: 1 });
    const result = resultWithRequiredScorer();
    const definitions = [
      null,
      ...result.metadata.evaluationConfig.definitions,
      undefined,
    ];
    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://legacy.example",
      results: [
        {
          ...result,
          metadata: { ...result.metadata, evaluationConfig: { definitions } },
        },
      ],
    } as any);

    const sent = requests.flatMap((request) => request.body.results ?? []);
    expect(sent).toHaveLength(1);
    expect(sent[0].metadata.evaluationConfig.definitions).toEqual([
      null,
      { scorerId: "s1", role: "gating", kind: "assertion" },
      { scorerId: "s2", role: "advisory", kind: "assertion" },
      null,
    ]);
    expect(definitions[1]?.role).toBe("required");
    expect(definitions[3]).toBeUndefined();
  });

  it("downgrades to the legacy spelling for a target that does not advertise it", async () => {
    stubTarget({ evalsRunMetadata: 1 });

    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://legacy.example",
      results: [resultWithRequiredScorer()],
    } as any);

    // The advisory row is untouched: this projects a spelling, not a tier.
    expect(rolesSent()).toEqual(["gating", "advisory"]);
  });

  it("stays frozen even for a target that advertises the canonical value", async () => {
    // The freeze is unconditional on this path. A target that speaks the
    // canonical vocabulary still reads `required` — through the projection on
    // the way OUT, not through the spelling on the way in.
    stubTarget({
      evalsRunMetadata: 1,
      vocabulary: { values: { role: ["gating", "required"] } },
    });

    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://modern.example",
      results: [resultWithRequiredScorer()],
    } as any);

    expect(rolesSent()).toEqual(["gating", "advisory"]);
  });

  it("downgrades when the capability probe cannot be answered at all", async () => {
    // A failed probe must read as "does not advertise". Emitting canonical to a
    // target that would have taken it costs nothing; the reverse empties a run.
    stubTarget(null);

    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://unreachable.example",
      results: [resultWithRequiredScorer()],
    } as any);

    expect(rolesSent()).toEqual(["gating", "advisory"]);
  });

  it("probes the target's capabilities at most once per run", async () => {
    // Three consumers need them, and two probes could disagree about one
    // deployment if they landed on either side of a deploy.
    stubTarget({ evalsRunMetadata: 1 });

    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://legacy.example",
      runName: "named run",
      results: [resultWithRequiredScorer()],
    } as any);

    expect(
      requests.filter((r) => r.url.endsWith("/capabilities")).length
    ).toBeLessThanOrEqual(1);
  });

  it("leaves a payload that carries no canonical role byte-identical", async () => {
    stubTarget({ evalsRunMetadata: 1 });

    await reportEvalResultsWithReceipt({
      apiKey: "key",
      suiteName: "policy",
      externalRunId: "invocation",
      baseUrl: "https://legacy.example",
      results: [
        {
          caseTitle: "case",
          passed: true,
          metadata: {
            scores: [{ scorerId: "s1", status: "passed" }],
            evaluationConfig: {
              definitions: [{ scorerId: "s1", role: "gating" }],
            },
          },
        },
      ],
    } as any);

    expect(rolesSent()).toEqual(["gating"]);
  });
});

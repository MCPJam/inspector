import {
  buildEvalRunReport,
  renderStructuredRunHtml,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  summarizeStructuredCases,
  type StructuredRunReport,
} from "../src/structured-reporting";
import type { EvalDecisionSummary } from "../src/eval-decision-summary";
import { parseJUnitXmlArtifact } from "../src/artifact-parsers";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "../src/platform/types";

describe("summarizeStructuredCases", () => {
  it("computes totals, category rollups, and classification rollups", () => {
    const summary = summarizeStructuredCases([
      {
        id: "tool:echo",
        title: "echo",
        category: "tools",
        passed: true,
        classification: "non_breaking",
      },
      {
        id: "schema:echo:input",
        title: "echo:input",
        category: "schemas",
        passed: false,
        classification: "breaking",
      },
    ]);

    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      byCategory: {
        tools: { total: 1, passed: 1, failed: 0 },
        schemas: { total: 1, passed: 0, failed: 1 },
      },
      byClassification: {
        non_breaking: { total: 1, passed: 1, failed: 0 },
        breaking: { total: 1, passed: 0, failed: 1 },
      },
    });
  });
});

describe("renderStructuredRunJson", () => {
  it("redacts sensitive metadata before serialization", () => {
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "tools-call-validation",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 5,
      metadata: {
        headers: { Authorization: "Bearer super-secret" },
        refreshToken: "refresh-secret",
      },
    };

    expect(renderStructuredRunJson(report)).toEqual({
      ...report,
      metadata: {
        headers: { Authorization: "[REDACTED]" },
        refreshToken: "[REDACTED]",
      },
    });
  });

  it("carries an optional decision summary through telemetry redaction", () => {
    const decisionSummary = {
      verdict: "failed" as const,
      passRate: { total: 1, passed: 0, failed: 1, percent: 0 },
      iterationWalkComplete: true,
      cases: [],
    };
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval",
      passed: false,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
      decisionSummary,
    };
    expect(renderStructuredRunJson(report)).toEqual(report);
  });

  it("keeps reports without a decision summary unchanged", () => {
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    };
    expect(renderStructuredRunJson(report)).toEqual(report);
  });
});

describe("renderStructuredRunJUnitXml", () => {
  it("emits the fixed synthetic pass for empty server diffs", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "server-diff",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('classname="mcpjam.server-diff"');
    expect(xml).toContain('name="no-drift"');
  });

  it("emits the fixed synthetic pass for empty tool validation reports", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "tools-call-validation",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('classname="mcpjam.tools-call-validation"');
    expect(xml).toContain('name="validation-passed"');
  });

  it("escapes the characters XML 1.0 forbids outright", () => {
    // A failing eval case carries an iteration's `error`, which is model- and
    // server-authored. XML 1.0 rejects most control characters and any
    // unpaired surrogate OUTRIGHT — they cannot even be written as character
    // references — so one of them here produces a report no JUnit parser will
    // read, and the CI job then fails inside the parser with nothing pointing
    // back at us.
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "eval-run",
      passed: false,
      summary: summarizeStructuredCases([]),
      cases: [
        {
          id: "run-1:case-a",
          title: "Case A",
          category: "eval",
          passed: false,
          error: "tool returned \u0000 then gave up\u001b[0m",
          details: { tail: "truncated\ud800" },
        },
      ],
      durationMs: 0,
      metadata: {},
    });

    // The invariant, asserted directly: nothing illegal survives anywhere in
    // the document. (`@xmldom/xmldom` is too lenient to serve as the oracle —
    // it parses a NUL without complaint, where the parsers CI actually runs
    // do not.)
    expect(xml).not.toMatch(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDFFF]/u
    );
    // Escaped, not dropped: the byte is usually the interesting half.
    expect(xml).toContain("\\u0000");
    expect(xml).toContain("\\u001b");
    expect(xml).toContain("\\ud800");

    const parsed = parseJUnitXmlArtifact(xml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].passed).toBe(false);
  });

  it("emits a synthetic failure when an empty run failed overall", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "server-diff",
      passed: false,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="failed"');
    expect(xml).toContain("Run failed without individual cases.");
  });
});

describe("renderStructuredRunHtml", () => {
  function baseReport(
    overrides: Partial<StructuredRunReport> = {}
  ): StructuredRunReport {
    return {
      schemaVersion: 1,
      kind: "eval-run",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
      ...overrides,
    };
  }

  it("emits a well-formed, self-contained document with no external assets", () => {
    const html = renderStructuredRunHtml(
      baseReport({
        passed: false,
        cases: [
          {
            id: "case-1",
            title: "Case A",
            category: "eval",
            passed: false,
            error: "goal missed",
          },
        ],
        summary: summarizeStructuredCases([
          {
            id: "case-1",
            title: "Case A",
            category: "eval",
            passed: false,
          },
        ]),
      })
    );

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script/i);
    // No external stylesheets, fonts, images, or scripts: this is a CI
    // artifact opened from disk, often over file:// with no network.
    expect(html).not.toMatch(/(href|src)\s*=\s*["']https?:\/\//i);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
  });

  it("does not paint a failed case's error text the same color as its own background", () => {
    // `.badge-fail` sets a red BACKGROUND for the small pass/fail badges;
    // `.error` sets the diagnostic text to that same red. A failed case's
    // <article> must not carry the badge class itself, or the two rules
    // together render red-on-red — the report's primary diagnostic,
    // invisible.
    const html = renderStructuredRunHtml(
      baseReport({
        passed: false,
        cases: [
          {
            id: "case-1",
            title: "Case A",
            category: "eval",
            passed: false,
            error: "goal missed",
          },
        ],
        summary: summarizeStructuredCases([
          {
            id: "case-1",
            title: "Case A",
            category: "eval",
            passed: false,
          },
        ]),
      })
    );

    expect(html).not.toMatch(/<article class="[^"]*\bbadge-fail\b/);
  });

  it("escapes hostile case titles and error text", () => {
    const hostileTitle = "</td></tr><script>alert(1)</script>";
    const html = renderStructuredRunHtml(
      baseReport({
        passed: false,
        cases: [
          {
            id: "case-1",
            title: hostileTitle,
            category: "eval",
            passed: false,
            error: `<b>bold</b> & "quoted" & 'single'`,
          },
        ],
        summary: summarizeStructuredCases([
          {
            id: "case-1",
            title: hostileTitle,
            category: "eval",
            passed: false,
          },
        ]),
      })
    );

    expect(html).not.toContain(hostileTitle);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(
      "&lt;/td&gt;&lt;/tr&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
    );
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;");
  });

  it("renders the decision summary when present", () => {
    const decisionSummary: EvalDecisionSummary = {
      verdict: "failed",
      passRate: { total: 4, passed: 3, failed: 1, percent: 75 },
      iterationWalkComplete: true,
      cases: [
        {
          id: "case-1",
          title: "Case A",
          iterationNumber: 1,
          firstFailedStage: "serverData",
          failureCategory: "serverData",
          stageChainStatus: "verified",
          expected: { toolNames: ["search"] },
          observed: { toolNames: ["search"], failure: "empty result" },
          evidence: { spanIds: ["span-1"] },
          nextAction: "inspect the tool response returned by the server",
        },
      ],
    };
    const html = renderStructuredRunHtml(
      baseReport({ passed: false, decisionSummary })
    );

    expect(html).toContain("Decision summary");
    expect(html).toContain("3/4 cases passed");
    expect(html).toContain("75%");
    expect(html).toContain("serverData");
    expect(html).toContain("inspect the tool response returned by the server");
    expect(html).toContain("span-1");
  });

  it("omits the decision summary section cleanly when absent", () => {
    const html = renderStructuredRunHtml(baseReport());
    expect(html).not.toContain("Decision summary");
  });

  it("renders an inconclusive verdict with the neutral class, never pass or fail", () => {
    const html = renderStructuredRunHtml(
      baseReport({ passed: false, verdict: "inconclusive" })
    );

    expect(html).toContain('badge-neutral">inconclusive');
    expect(html).not.toContain('badge-pass">inconclusive');
    expect(html).not.toContain('badge-fail">inconclusive');
  });

  it("renders a diagnostic case neutrally, not as a failure, when it is classified informational", () => {
    // A gate/compare report's synthetic case for a fetch failure, timeout,
    // or missing baseline is `passed: false` too — same as a real
    // regression — but it's a diagnostic explaining why nothing was
    // measured, not a confirmed failure. `classification: "informational"`
    // is the marker for this (set by gateReportCase/gateCase); it must not
    // get the same red border/text and "Failures" heading a real failure
    // gets.
    const diagnosticCase = {
      id: "gate",
      title: "Eval gate",
      category: "gate",
      passed: false,
      classification: "informational" as const,
      error: "run is cancelled; no verdict was established",
    };
    const html = renderStructuredRunHtml(
      baseReport({
        passed: false,
        verdict: "inconclusive",
        cases: [diagnosticCase],
        summary: summarizeStructuredCases([diagnosticCase]),
      })
    );

    // "case-fail" is still present as a static CSS rule in <style>, so check
    // the actual article element's class, not the whole document.
    expect(html).not.toMatch(/<article class="case case-fail">/);
    expect(html).toMatch(/<article class="case case-neutral">/);
    expect(html).not.toMatch(/<p class="error">/);
    expect(html).not.toMatch(/Failures \(\d+\)/);
    expect(html).toContain("Not measured");
    // The count is still accurate, just annotated rather than hidden.
    expect(html).toContain("1 failed");
    expect(html).toContain("not measured, not a confirmed regression");
  });

  it("keeps a genuinely observed failure red even when it sits beside a diagnostic case", () => {
    // The bug this guards: an eval gate report can carry a real failed
    // iteration row AND its own non-gateable diagnostic case together (a
    // completed run with real failures, gated by a policy the run couldn't
    // be evaluated against). Collapsing the whole page to the report's
    // overall "inconclusive" status would paint the real failure neutral
    // too and hide it under "Not measured" — worse than the red/neutral
    // conflation this file exists to fix.
    const realFailure = {
      id: "case-1",
      title: "Case A",
      category: "eval",
      passed: false,
      error: "goal completion failed",
    };
    const diagnosticCase = {
      id: "gate",
      title: "Eval gate",
      category: "gate",
      passed: false,
      classification: "informational" as const,
      error: "score integrity unverified; gate is non-gateable",
    };
    const html = renderStructuredRunHtml(
      baseReport({
        passed: false,
        verdict: "inconclusive",
        cases: [realFailure, diagnosticCase],
        summary: summarizeStructuredCases([realFailure, diagnosticCase]),
      })
    );

    expect(html).toMatch(/<article class="case case-fail">/);
    expect(html).toMatch(/<article class="case case-neutral">/);
    expect(html).toContain("Failures (1)");
    expect(html).toContain("Not measured");
    expect(html).toMatch(/<p class="error">goal completion failed<\/p>/);
    // Real failures are present, so the summary must not claim the total is
    // all-diagnostic.
    expect(html).not.toContain("not measured, not a confirmed regression");
  });

  it("renders an incomplete gate's iteration-fetch diagnostic neutrally, not as a Failures entry", () => {
    // End-to-end version of the `buildEvalRunReport` classification test
    // above: build the report the way `eval gate` actually does — the
    // underlying run as an input (so the "reporting" case auto-generates)
    // plus the gate's own synthetic case, verdict overridden to
    // "inconclusive" — then render it and check the page, not just the
    // report shape.
    const report = buildEvalRunReport(
      [
        {
          run: {
            id: "run-1",
            suiteId: "suite-1",
            runNumber: 1,
            status: "completed",
            result: "inconclusive",
            summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
            source: "api",
            notes: null,
            createdAt: 100,
            completedAt: 300,
          } as unknown as PlatformEvalRun,
          iterations: [],
          iterationsComplete: false,
          iterationError: "page 2 failed",
        },
      ],
      {
        cases: [
          {
            id: "gate",
            title: "Eval gate",
            category: "gate",
            passed: false,
            classification: "informational",
            error: "the run is incomplete; no verdict was established",
          },
        ],
        verdict: "inconclusive",
      }
    );
    const html = renderStructuredRunHtml(report);

    expect(html).not.toMatch(/<article class="case case-fail">/);
    expect(html).not.toMatch(/Failures \(\d+\)/);
    expect(html).toContain("Not measured");
    expect(html).toMatch(/run-1: iteration results/);
  });

  it("renders a passed verdict as pass and a failed verdict as fail", () => {
    const passedHtml = renderStructuredRunHtml(
      baseReport({ passed: true, verdict: "passed" })
    );
    expect(passedHtml).toContain('badge-pass">passed');

    const failedHtml = renderStructuredRunHtml(
      baseReport({ passed: false, verdict: "failed" })
    );
    expect(failedHtml).toContain('badge-fail">failed');
  });
});

describe("buildEvalRunReport", () => {
  it("honors an explicit verdict override instead of computing one from inputs", () => {
    // A gate/compare report's `inputs` describe the underlying eval run, not
    // the gate's own outcome — a run can pass while its gate is
    // non-gateable. With empty inputs (no run info at all, e.g. a gate
    // fetch failure), the auto-computed verdict would be omitted entirely,
    // and a renderer with no verdict falls back to `passed` — false for
    // every non-"passed" outcome, painting an unmeasured gate the same red
    // as a measured failure. The override must win.
    const report = buildEvalRunReport([], {
      cases: [
        { id: "gate", title: "Eval gate", category: "gate", passed: false },
      ],
      verdict: "inconclusive",
    });
    expect(report.verdict).toBe("inconclusive");
    expect(report.passed).toBe(false);
  });

  it("folds iterations into one testcase per case and preserves failure messages", () => {
    const run = {
      id: "run-1",
      suiteId: "suite-1",
      runNumber: 1,
      status: "completed",
      result: "failed",
      summary: { total: 3, passed: 2, failed: 1, passRate: 2 / 3 },
      source: "api",
      notes: null,
      createdAt: 100,
      completedAt: 300,
    } satisfies PlatformEvalRun;
    const iteration = (
      id: string,
      testCaseId: string,
      title: string,
      iterationNumber: number,
      result: "passed" | "failed",
      error: string | null
    ) =>
      ({
        id,
        testCaseId,
        title,
        iterationNumber,
        status: "completed",
        result,
        model: null,
        provider: null,
        startedAt: null,
        durationMs: 10,
        tokensUsed: null,
        usage: null,
        actualToolCalls: [],
        expectedToolCalls: [],
        error,
      } satisfies PlatformEvalIteration);
    const report = buildEvalRunReport([
      {
        run,
        iterationsComplete: true,
        iterations: [
          iteration("i-1", "case-a", "Case A", 1, "passed", null),
          iteration("i-2", "case-a", "Case A", 2, "failed", "goal missed"),
          iteration("i-3", "case-b", "Case B", 1, "passed", null),
        ],
      },
    ]);

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "eval-run",
      passed: false,
      summary: { total: 2, passed: 1, failed: 1 },
      durationMs: 200,
    });
    expect(report.cases).toHaveLength(2);
    expect(report.cases[0]).toMatchObject({
      id: "run-1:case-a",
      title: "Case A",
      passed: false,
      error: "goal missed",
      durationMs: 20,
    });

    const parsed = parseJUnitXmlArtifact(renderStructuredRunJUnitXml(report));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].passed).toBe(false);
    expect(parsed[0].error).toContain("goal missed");
    expect(parsed[1].passed).toBe(true);
  });

  it("carries an INCONCLUSIVE backend verdict instead of recomputing one", () => {
    const report = buildEvalRunReport([
      {
        run: {
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 1,
          status: "completed",
          result: "inconclusive",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 100,
          completedAt: 300,
          verdictPolicyVersion: 2,
          verdictSummary: {
            policyVersion: 2,
            verdict: "inconclusive",
            reasons: ["insufficientCompletion"],
            validity: {
              valid: false,
              coverage: {
                configuredTrials: 4,
                attemptedTrials: 1,
                eligibleTrials: 1,
                minEligibleTrials: null,
              },
              completionRate: {
                state: "measured",
                numerator: 1,
                denominator: 4,
                rate: 0.25,
                threshold: 0.8,
                met: false,
              },
              evaluatorErrorRate: {
                state: "measured",
                numerator: 0,
                denominator: 1,
                rate: 0,
                threshold: 0.1,
                met: true,
              },
            },
          },
        } as unknown as PlatformEvalRun,
        iterations: [],
        iterationsComplete: true,
      },
    ]);

    // Undecided, not failed: `passed` stays false (nothing was established)
    // while `verdict` says which of the two it is.
    expect(report.passed).toBe(false);
    expect(report.verdict).toBe("inconclusive");
    // And NO synthetic `run-1:run` failure is invented for it — that case is
    // what turns an amber run into a red JUnit testcase in CI.
    expect(report.cases).toEqual([]);
    // The decision itself travels verbatim, reasons and denominators included,
    // because the reader cannot reconstruct it from the summary counts.
    expect(report.metadata.runs?.[0]).toMatchObject({
      verdictPolicyVersion: 2,
      verdictSummary: {
        verdict: "inconclusive",
        reasons: ["insufficientCompletion"],
        validity: {
          completionRate: { numerator: 1, denominator: 4, met: false },
        },
      },
    });
  });

  it("lets one measured failure outrank an inconclusive sibling run", () => {
    const base = {
      suiteId: "suite-1",
      runNumber: 1,
      status: "completed",
      summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
      source: "api",
      notes: null,
      createdAt: 100,
      completedAt: 200,
    };
    const report = buildEvalRunReport([
      {
        run: {
          ...base,
          id: "run-a",
          result: "inconclusive",
        } as unknown as PlatformEvalRun,
        iterations: [],
        iterationsComplete: true,
      },
      {
        run: { ...base, id: "run-b", result: "failed" } as PlatformEvalRun,
        iterations: [],
        iterationsComplete: true,
      },
    ]);

    // One measured regression is a regression whatever else was unmeasurable.
    expect(report.verdict).toBe("failed");
    // The failed run still gets its run-level case; the inconclusive one does
    // not.
    expect(report.cases.map((entry) => entry.id)).toEqual(["run-b:run"]);
  });

  it("does not report an inconclusive verdict off an unreadable run", () => {
    // The iterations page failed, so "the platform declined to decide" is not
    // something this report knows: it only knows it could not read the run.
    const report = buildEvalRunReport([
      {
        run: {
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 1,
          status: "completed",
          result: "inconclusive",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 100,
          completedAt: 300,
        } as unknown as PlatformEvalRun,
        iterations: [],
        iterationsComplete: false,
        iterationError: "page 2 failed",
      },
    ]);

    expect(report.verdict).toBe("failed");
    expect(report.cases[0]).toMatchObject({
      id: "run-1:iterations",
      passed: false,
    });
  });

  it("adds a failing reporting testcase when iteration pagination is incomplete", () => {
    const report = buildEvalRunReport([
      {
        run: {
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 1,
          status: "completed",
          result: "passed",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 100,
          completedAt: 300,
        },
        iterations: [],
        iterationsComplete: false,
        iterationError: "page 2 failed",
      },
    ]);

    expect(report.passed).toBe(false);
    expect(report.cases).toEqual([
      expect.objectContaining({
        id: "run-1:iterations",
        passed: false,
        error: "page 2 failed",
      }),
    ]);
  });

  it("classifies the incomplete-iteration-retrieval case as informational, not an observed failure", () => {
    // A gate composes this report by passing the underlying run as an input
    // (so this "reporting" case gets auto-generated) alongside its own
    // synthetic gate case, then overrides the verdict via
    // `gateOutcomeVerdict`. When retrieval was incomplete, that verdict is
    // "inconclusive" — but this case had no `classification`, so
    // `isDiagnosticCase` treated it as an observed failure and the HTML
    // report painted it red under "Failures" despite the header saying
    // nothing was measured.
    const report = buildEvalRunReport(
      [
        {
          run: {
            id: "run-1",
            suiteId: "suite-1",
            runNumber: 1,
            status: "completed",
            result: "inconclusive",
            summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
            source: "api",
            notes: null,
            createdAt: 100,
            completedAt: 300,
          } as unknown as PlatformEvalRun,
          iterations: [],
          iterationsComplete: false,
          iterationError: "page 2 failed",
        },
      ],
      { verdict: "inconclusive" }
    );

    expect(report.cases).toEqual([
      expect.objectContaining({
        id: "run-1:iterations",
        passed: false,
        classification: "informational",
      }),
    ]);
  });
});

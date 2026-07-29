// The submission report's only job is to be honest about a run. Every case
// below is a way it could quietly stop being.

import { describe, expect, it } from "vitest";
import {
  buildOpenAiSubmissionReport,
  renderOpenAiSubmissionReport,
  type SubmissionRunCase,
} from "../openai-submission-report";

function testCase(
  overrides: Partial<SubmissionRunCase> & { title: string }
): SubmissionRunCase {
  return {
    query: "do the thing",
    isNegativeTest: false,
    expectedToolCalls: ["acme_search"],
    actualToolCalls: ["acme_search"],
    passed: true,
    ...overrides,
  };
}

const BUNDLE = {
  name: "acme",
  pluginVersionId: "pv1",
  bundleHash: "a".repeat(64),
};

function positives(count: number, passed = true): SubmissionRunCase[] {
  return Array.from({ length: count }, (_unused, i) =>
    testCase({ title: `pos-${i}`, passed })
  );
}
function negatives(count: number, passed = true): SubmissionRunCase[] {
  return Array.from({ length: count }, (_unused, i) =>
    testCase({
      title: `neg-${i}`,
      isNegativeTest: true,
      expectedToolCalls: [],
      actualToolCalls: [],
      passed,
    })
  );
}

describe("buildOpenAiSubmissionReport", () => {
  it("selects OpenAI's 5 positive / 3 negative shape", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [...positives(7), ...negatives(4)],
      pluginVersions: [BUNDLE],
    });
    expect(report.positive).toHaveLength(5);
    expect(report.negative).toHaveLength(3);
    expect(report.readiness).toEqual([]);
  });

  it("reports a shortfall rather than padding with the wrong kind", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [...positives(3), ...negatives(1)],
      pluginVersions: [BUNDLE],
    });
    expect(report.positive).toHaveLength(3);
    expect(report.readiness).toEqual([
      { code: "insufficient_positive", have: 3, need: 5 },
      { code: "insufficient_negative", have: 1, need: 3 },
    ]);
  });

  // THE case that decides whether this tool can be used to launder a run:
  // there are enough passing positives to fill the quota, so the failing one
  // must not be silently dropped in favour of them... except there aren't, and
  // it must be included AND reported.
  it("includes a failing case when it is needed to reach the quota, and says so", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [
        ...positives(4),
        testCase({ title: "flaky", passed: false }),
        ...negatives(3),
      ],
      pluginVersions: [BUNDLE],
    });
    expect(report.positive.map((c) => c.title)).toContain("flaky");
    expect(report.readiness).toEqual([
      { code: "failing_cases", titles: ["flaky"] },
    ]);
  });

  // ...and when there ARE enough passing ones, passing cases win the slots.
  // That is a selection preference, not concealment: nothing failing was needed.
  it("prefers passing cases when the quota can be filled without a failure", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [
        testCase({ title: "flaky", passed: false }),
        ...positives(5),
        ...negatives(3),
      ],
      pluginVersions: [BUNDLE],
    });
    expect(report.positive.map((c) => c.title)).not.toContain("flaky");
    expect(report.readiness).toEqual([]);
  });

  it("refuses to imply a bundle when the run pinned none", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [...positives(5), ...negatives(3)],
      pluginVersions: [],
    });
    expect(report.readiness).toEqual([{ code: "no_plugin_pinned" }]);
  });

  // The "without skills" A/B arm produces real results about a deliberately
  // reduced configuration. Submitting it as evidence for the plugin is wrong.
  it("flags the skills-excluded arm", () => {
    const report = buildOpenAiSubmissionReport({
      suiteName: "S",
      runLabel: "Run 1",
      cases: [...positives(5), ...negatives(3)],
      pluginVersions: [BUNDLE],
      skillsExcluded: true,
    });
    expect(report.readiness).toEqual([{ code: "skills_excluded" }]);
  });

  it("is stable: the same run renders the same document", () => {
    const args = {
      suiteName: "S",
      runLabel: "Run 1",
      cases: [...positives(6), ...negatives(3)],
      pluginVersions: [BUNDLE],
      now: 1,
    };
    expect(
      renderOpenAiSubmissionReport(buildOpenAiSubmissionReport(args))
    ).toBe(renderOpenAiSubmissionReport(buildOpenAiSubmissionReport(args)));
  });
});

describe("renderOpenAiSubmissionReport", () => {
  it("states the full bundle hash — the thing the report is evidence about", () => {
    const md = renderOpenAiSubmissionReport(
      buildOpenAiSubmissionReport({
        suiteName: "S",
        runLabel: "Run 1",
        cases: [...positives(5), ...negatives(3)],
        pluginVersions: [BUNDLE],
        now: 1,
      })
    );
    expect(md).toContain(BUNDLE.bundleHash);
    expect(md).toContain("**acme**");
  });

  it("puts readiness problems above the results, not in a footnote", () => {
    const md = renderOpenAiSubmissionReport(
      buildOpenAiSubmissionReport({
        suiteName: "S",
        runLabel: "Run 1",
        cases: positives(1),
        pluginVersions: [BUNDLE],
        now: 1,
      })
    );
    expect(md.indexOf("## Not ready to submit")).toBeLessThan(
      md.indexOf("## Should invoke")
    );
  });

  it("carries the negative case's scenario, which is what a reviewer reads", () => {
    const md = renderOpenAiSubmissionReport(
      buildOpenAiSubmissionReport({
        suiteName: "S",
        runLabel: "Run 1",
        cases: [
          testCase({
            title: "unrelated",
            isNegativeTest: true,
            expectedToolCalls: [],
            actualToolCalls: [],
            scenario: "A weather question has nothing to do with invoicing.",
          }),
        ],
        pluginVersions: [BUNDLE],
        now: 1,
      })
    );
    expect(md).toContain("A weather question has nothing to do with invoicing.");
  });
});

/**
 * How a readiness result renders — and what it must never become.
 *
 * Two properties are the whole point of the adapter:
 *
 *   1. It carries NO conformance score, so it cannot be pooled into
 *      `pooledConformanceScore` or the public score. Anthropic's listing
 *      policy is not the MCP specification and a number that mixed them would
 *      be meaningless in both directions.
 *   2. Advisories render as JUnit `<properties>`, never as failed testcases. A
 *      CI job that goes red on a heuristic gets `|| true` appended to it, and
 *      then the real findings stop being read too.
 */

import { describe, expect, it } from "vitest";

import {
  renderConformanceReportJUnitXml,
  toConformanceReport,
} from "../../src/conformance-reporting.js";
import { pooledConformanceScore } from "../../src/conformance-score.js";
import {
  CLAUDE_POLICY_SNAPSHOT_DATE,
  CLAUDE_READINESS_ENGINE_VERSION,
  claudePolicySource,
  summarizeLaneCoverage,
  type ClaudeReadinessFinding,
  type ClaudeReadinessResult,
} from "../../src/claude-readiness/index.js";

function makeFinding(
  overrides: Partial<ClaudeReadinessFinding> &
    Pick<ClaudeReadinessFinding, "id" | "class" | "status" | "lane">,
): ClaudeReadinessFinding {
  return {
    title: overrides.title ?? overrides.id,
    provenance: "wire",
    intrusiveness: "read-only",
    source: claudePolicySource("directory", "§Overview"),
    evaluatedAt: "2026-08-19T00:00:00.000Z",
    engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
    ...overrides,
  };
}

function makeResult(
  findings: ClaudeReadinessFinding[],
  status: ClaudeReadinessResult["status"] = "not-ready",
): ClaudeReadinessResult {
  const lanes: ClaudeReadinessResult["lanes"] = [
    {
      lane: "runtime-compatibility",
      status: "ready",
      summary: "Claude can connect and authenticate.",
      coverage: summarizeLaneCoverage(
        "runtime-compatibility",
        findings.filter((f) => f.lane === "runtime-compatibility"),
      ),
    },
    {
      lane: "directory-policy",
      status: status === "ready" ? "ready" : "not-ready",
      summary: "One submission requirement is unmet.",
      coverage: summarizeLaneCoverage(
        "directory-policy",
        findings.filter((f) => f.lane === "directory-policy"),
      ),
    },
    {
      lane: "experience-insights",
      status: "incomplete",
      summary: "Heuristics only.",
      coverage: summarizeLaneCoverage(
        "experience-insights",
        findings.filter((f) => f.lane === "experience-insights"),
        ["llmInsights"],
      ),
    },
  ];
  return {
    status,
    summary: "One directory-policy requirement is unmet.",
    context: {
      target: "https://mcp.example.com/mcp",
      authMode: "headless",
      capabilities: ["dns"],
      evidenceSources: ["protocol-conformance"],
    },
    lanes,
    findings,
    badges: [],
    policySnapshotDate: CLAUDE_POLICY_SNAPSHOT_DATE,
    engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
    startedAt: "2026-08-19T00:00:00.000Z",
    durationMs: 1234,
  };
}

const FINDINGS = [
  makeFinding({
    id: "tool-annotations-present",
    lane: "directory-policy",
    class: "required",
    status: "violated",
    remediation: "Annotate every tool with readOnlyHint or destructiveHint.",
  }),
  makeFinding({
    id: "prm-resource-exact-match",
    lane: "runtime-compatibility",
    class: "required",
    status: "satisfied",
  }),
  makeFinding({
    id: "financial-transfer-tool",
    lane: "experience-insights",
    class: "heuristic",
    status: "violated",
    remediation: "A tool appears to move money; review the confirmation flow.",
  }),
  makeFinding({
    id: "lazy-auth-supported",
    lane: "experience-insights",
    class: "experimental-feature",
    status: "informational",
  }),
];

describe("toConformanceReport for readiness", () => {
  it("uses its own kind and never carries a conformance score", () => {
    const report = toConformanceReport(makeResult(FINDINGS));

    expect(report.kind).toBe("claude-directory-readiness");
    expect(report.score).toBeUndefined();
    // And so it contributes nothing when a caller pools scores. Pooling the
    // report's OWN (absent) score is what makes this assertion about the
    // readiness adapter rather than about `pooledConformanceScore([])`, which
    // returns null by definition and would pass either way.
    const contributed = [report.score].filter(
      (score): score is NonNullable<typeof score> => score !== undefined,
    );
    expect(contributed).toEqual([]);
    expect(pooledConformanceScore(contributed).score).toBeNull();
  });

  it("maps the readiness verdict onto the shared outcome vocabulary", () => {
    expect(toConformanceReport(makeResult(FINDINGS)).outcome).toBe("failed");
    expect(toConformanceReport(makeResult([], "ready")).outcome).toBe("passed");

    const incomplete = toConformanceReport(makeResult([], "incomplete"));
    expect(incomplete.outcome).toBe("incomplete");
    expect(incomplete.incompleteReason).toBeTruthy();
  });

  it("makes only dispositive findings testcases", () => {
    const report = toConformanceReport(makeResult(FINDINGS));
    const caseIds = report.groups.flatMap((group) =>
      group.cases.map((entry) => entry.id),
    );

    expect(caseIds).toEqual([
      "prm-resource-exact-match",
      "tool-annotations-present",
    ]);
    expect(caseIds).not.toContain("financial-transfer-tool");
  });

  it("routes the rest to advisories, tagged with the lane that raised them", () => {
    const report = toConformanceReport(makeResult(FINDINGS));

    expect(report.advisories?.map((entry) => entry.id)).toEqual([
      "financial-transfer-tool",
      "lazy-auth-supported",
    ]);
    expect(report.advisories?.[0]).toMatchObject({
      group: "experience-insights",
      kind: "heuristic",
      status: "violated",
    });
  });

  it("keeps a lane that could not be evaluated out of the passed column", () => {
    const report = toConformanceReport(makeResult(FINDINGS));
    const insights = report.groups.find(
      (group) => group.id === "experience-insights",
    );
    expect(insights?.passed).toBe(false);
  });

  it("distinguishes an untested obligation from an inapplicable one", () => {
    const report = toConformanceReport(
      makeResult([
        makeFinding({
          id: "screenshots-present",
          lane: "directory-policy",
          class: "required",
          status: "not-evaluated",
          notEvaluatedReason: "no submission profile was supplied",
        }),
        makeFinding({
          id: "app-mime-profile",
          lane: "directory-policy",
          class: "required",
          status: "not-applicable",
        }),
      ]),
    );
    const cases = report.groups.flatMap((group) => group.cases);

    expect(cases.find((c) => c.id === "screenshots-present")?.skipReason).toBe(
      "could-not-run",
    );
    expect(cases.find((c) => c.id === "app-mime-profile")?.skipReason).toBe(
      "not-applicable",
    );
  });
});

describe("JUnit rendering", () => {
  it("renders advisories as properties, not as failures", () => {
    const xml = renderConformanceReportJUnitXml(
      toConformanceReport(makeResult(FINDINGS)),
    );

    expect(xml).toContain(
      '<property name="mcpjam.advisory.financial-transfer-tool"',
    );
    // Exactly one failure: the violated REQUIREMENT. The violated heuristic
    // beside it must not have produced a second one.
    expect(xml.match(/<failure /g) ?? []).toHaveLength(1);
    expect(xml).toContain('failures="1"');
  });

  it("puts each advisory under the testsuite that raised it", () => {
    const xml = renderConformanceReportJUnitXml(
      toConformanceReport(makeResult(FINDINGS)),
    );
    // Pinned BEFORE slicing. A renamed or reordered suite makes `indexOf`
    // return -1, and `slice(-1, n)` yields a near-empty string that satisfies
    // `not.toContain` on nothing at all — the assertion survives while the
    // coverage quietly does not.
    const insightsAt = xml.indexOf('<testsuite name="experience-insights"');
    const policyAt = xml.indexOf('<testsuite name="directory-policy"');
    expect(insightsAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(insightsAt);

    expect(xml.slice(insightsAt)).toContain(
      "mcpjam.advisory.financial-transfer-tool",
    );
    // The policy lane raised no advisories, so it gets no properties block.
    expect(xml.slice(policyAt, insightsAt)).not.toContain("<properties>");
  });

  it("stays valid XML when an advisory message contains markup", () => {
    const xml = renderConformanceReportJUnitXml(
      toConformanceReport(
        makeResult([
          makeFinding({
            id: "quote-and-angle",
            lane: "experience-insights",
            class: "heuristic",
            status: "violated",
            remediation: 'Use <b>"safe"</b> & escape it',
          }),
        ]),
      ),
    );

    expect(xml).toContain("&lt;b&gt;&quot;safe&quot;&lt;/b&gt; &amp; escape it");
  });
});

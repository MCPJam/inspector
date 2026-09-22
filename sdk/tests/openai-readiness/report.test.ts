/**
 * Report routing with two readiness providers registered.
 *
 * The risk this file exists for is specific: Claude's readiness result and
 * OpenAI's are STRUCTURALLY IDENTICAL — both carry `lanes`, `findings` and
 * `badges` — so the shape test that was sufficient with one provider will
 * happily claim the other's result. A misrouted report is not a crash; it is a
 * correct-looking document published under the wrong publisher's name, which is
 * the kind of wrong that survives review.
 */

import { describe, expect, it } from "vitest";

import { toConformanceReport } from "../../src/conformance-reporting.js";
import { claudePolicySource } from "../../src/claude-readiness/manifest.js";
import type { ClaudeReadinessResult } from "../../src/claude-readiness/types.js";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import type { OpenAIReadinessEvidence } from "../../src/openai-readiness/runner.js";

function claudeResult(): ClaudeReadinessResult {
  return {
    status: "ready",
    summary: "Every requirement this run could evaluate is satisfied.",
    context: {
      target: "https://connector.example.com/mcp",
      authMode: "headless",
      capabilities: [],
      evidenceSources: [],
    },
    lanes: [
      {
        lane: "directory-policy",
        status: "ready",
        summary: "ok",
        coverage: {
          lane: "directory-policy",
          evaluated: 1,
          notEvaluated: 0,
          notApplicable: 0,
          missingInputs: [],
        },
      },
    ],
    findings: [
      {
        id: "claude.example",
        title: "An example requirement",
        lane: "directory-policy",
        class: "required",
        status: "satisfied",
        source: claudePolicySource("directory", "§Overview"),
        provenance: "wire",
        intrusiveness: "read-only",
        evaluatedAt: "2026-08-19T12:00:00.000Z",
        engineVersion: "1",
      },
    ],
    badges: [],
    policySnapshotDate: "2026-08-19",
    engineVersion: "1",
    startedAt: "2026-08-19T12:00:00.000Z",
    durationMs: 10,
  };
}

function openaiEvidence(): OpenAIReadinessEvidence {
  return {
    target: "https://plugin.example.com/mcp",
    mode: "mcp-only",
    authMode: "headless",
    capabilities: [],
    startedAt: "2026-08-19T12:00:00.000Z",
    evaluatedAt: "2026-08-19T12:00:05.000Z",
    durationMs: 5_000,
  };
}

describe("routing", () => {
  it("still routes a Claude result to the Claude descriptor", () => {
    const report = toConformanceReport(claudeResult());
    expect(report.kind).toBe("claude-directory-readiness");
    expect(report.name).toBe("Claude Directory Readiness");
  });

  it("routes an OpenAI result to its own descriptor", () => {
    const report = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    expect(report.kind).toBe("openai-directory-readiness");
    expect(report.name).toBe("OpenAI Plugin Directory Readiness");
  });

  it("does not confuse the two despite their identical shape", () => {
    // Both have `lanes`, `findings` and `badges`. Only the explicit
    // `readinessKind` separates them.
    const claude = toConformanceReport(claudeResult());
    const openai = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    expect(claude.kind).not.toBe(openai.kind);
  });
});

describe("neither readiness report is a conformance score", () => {
  it("omits `score` on both", () => {
    // Pooling a publisher's listing policy into a protocol-conformance number
    // would corrupt the number and the policy at once.
    expect(toConformanceReport(claudeResult()).score).toBeUndefined();
    expect(
      toConformanceReport(gradeOpenAIReadiness(openaiEvidence())).score,
    ).toBeUndefined();
  });
});

describe("the OpenAI report's contents", () => {
  it("renders one group per lane", () => {
    const report = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    expect(report.groups.map((group) => group.id)).toContain(
      "submission-artifacts",
    );
    expect(report.groups.map((group) => group.id)).toContain("plugin-package");
  });

  it("renders only dispositive findings as testcases", () => {
    const report = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    for (const group of report.groups) {
      for (const testCase of group.cases) {
        // A CI job that fails on a heuristic teaches its owners to ignore the
        // job; manual-review findings belong in advisories.
        expect(["required", "runtime-blocker"]).toContain(testCase.category);
      }
    }
  });

  it("renders manual-review findings as advisories, not failures", () => {
    const report = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    const kinds = new Set(
      (report.advisories ?? []).map((advisory) => advisory.kind),
    );
    expect(kinds.has("manual-review")).toBe(true);
  });

  it("reports an incomplete run as incomplete rather than failed", () => {
    const report = toConformanceReport(gradeOpenAIReadiness(openaiEvidence()));
    // "did not run" must never read as "conformed", and it must not read as
    // "failed" either — those send a maintainer to fix different things.
    expect(report.outcome).toBe("incomplete");
    expect(report.passed).toBe(false);
    expect(report.incompleteReason).toBeTruthy();
  });
});

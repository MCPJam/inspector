/**
 * Whole-run behaviour, once every lane has checks in it.
 *
 * These are the assertions the product was designed around, and none of them
 * can be made from a single check module:
 *
 *   - a skills-only package with nothing else supplied is READY at the
 *     technical preflight and INCOMPLETE at submission-ready, because those are
 *     both true and a single verdict would have to lie about one;
 *   - an MCP-only run never asks for a `pluginBundle`, because that shape does
 *     not have one;
 *   - the JUnit-shaped report agrees with the verdict it is reporting.
 */

import { describe, expect, it } from "vitest";

import { toConformanceReport } from "../../src/conformance-reporting.js";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import type { OpenAIReadinessEvidence } from "../../src/openai-readiness/runner.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import type {
  OpenAIReadinessResult,
  OpenAISubmissionMode,
} from "../../src/openai-readiness/types.js";
import {
  InMemoryOpenAIPackageSource,
  archiveObservations,
  cleanSkillsPackage,
} from "./package-fixtures.js";
import { healthyServerEvidence } from "./server-fixtures.js";
import { completeSubmissionProfile } from "./submission-fixtures.js";

const BASE = {
  target: "https://plugin.example.com/mcp",
  authMode: "headless" as const,
  capabilities: [],
  startedAt: "2026-08-19T12:00:00.000Z",
  evaluatedAt: "2026-08-19T12:00:05.000Z",
  durationMs: 5_000,
};

const evidence = (
  overrides: Partial<OpenAIReadinessEvidence> & { mode: OpenAISubmissionMode },
): OpenAIReadinessEvidence => ({ ...BASE, ...overrides });

const stage = (result: OpenAIReadinessResult, name: string) =>
  result.stages.find((entry) => entry.stage === name)!;

const lane = (result: OpenAIReadinessResult, name: string) =>
  result.lanes.find((entry) => entry.lane === name)!;

async function cleanPackage() {
  return readOpenAIPluginPackage(
    new InMemoryOpenAIPackageSource(cleanSkillsPackage()),
    { archive: archiveObservations() },
  );
}

describe("a skills-only package with no submission profile", () => {
  it("is ready at the technical preflight and incomplete at submission-ready", async () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "skills-only", package: await cleanPackage() }),
    );
    // Both statements are true. A single verdict would have to lie about one,
    // and the one it would lie about is whichever the reader cares less about.
    expect(stage(result, "technical-preflight").status).toBe("ready");
    expect(stage(result, "submission-ready").status).toBe("incomplete");
    expect(result.status).toBe("incomplete");
  });

  it("says both in one line", async () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "skills-only", package: await cleanPackage() }),
    );
    // Reporting only the headline would tell a submitter "not ready" and send
    // them to look at a package that is fine.
    expect(result.summary).toContain("technical preflight");
    expect(result.summary).toContain("submissionProfile");
  });

  it("becomes ready at both once a profile is supplied", async () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "skills-only",
        package: await cleanPackage(),
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    expect(stage(result, "technical-preflight").status).toBe("ready");
    expect(stage(result, "submission-ready").status).toBe("ready");
    expect(result.status).toBe("ready");
  });
});

describe("an mcp-only run with good wire evidence", () => {
  it("is ready at the technical preflight", () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", ...healthyServerEvidence() }),
    );
    expect(stage(result, "technical-preflight").status).toBe("ready");
  });

  it("never asks for a plugin bundle", () => {
    // That shape does not have one, so asking would be asking for something
    // that cannot exist.
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", ...healthyServerEvidence() }),
    );
    const gaps = result.lanes.flatMap((entry) => entry.coverage.missingInputs);
    expect(gaps).not.toContain("pluginBundle");
    expect(lane(result, "plugin-package").summary).toContain("Not applicable");
  });

  it("is ready at both stages with a profile as well", () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "mcp-only",
        ...healthyServerEvidence(),
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    expect(result.status).toBe("ready");
  });

  it("lets a runtime blocker fail the preflight", () => {
    const healthy = healthyServerEvidence();
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "mcp-only",
        ...healthy,
        endpoint: {
          enteredUrl: "http://plugin.example.com/mcp",
          redirectChain: [
            { url: "http://plugin.example.com/mcp", status: 200 },
          ],
        },
      }),
    );
    expect(lane(result, "runtime-compatibility").status).toBe("not-ready");
    expect(stage(result, "technical-preflight").status).toBe("not-ready");
  });
});

describe("an mcp-imported-skills run", () => {
  it("reports the skills gap when the listing was never read", () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-imported-skills", ...healthyServerEvidence() }),
    );
    expect(lane(result, "directory-policy").coverage.missingInputs).toContain(
      "importedSkills",
    );
  });

  it("is ready once the listing is clean", () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "mcp-imported-skills",
        ...healthyServerEvidence(),
        importedSkills: {
          extensionAdvertised: true,
          skills: [
            {
              name: "forecast",
              description: "Look up a forecast",
              declaredDigest: "abc",
              observedDigest: "abc",
              markdownBytes: 500,
              totalBytes: 500,
              frontmatter: {
                name: "forecast",
                description: "Look up a forecast",
              },
            },
          ],
          pagesWalked: 1,
          scannedAt: "2026-08-19T11:00:00.000Z",
        },
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    expect(stage(result, "technical-preflight").status).toBe("ready");
  });
});

describe("badges never move a verdict", () => {
  it("leaves a ready run ready with every badge unsupported", async () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "skills-only",
        package: await cleanPackage(),
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.badges.length).toBeGreaterThan(0);
    // The optional-features lane is not in either stage's lane set, by
    // construction rather than by promise.
    for (const entry of result.stages) {
      expect(entry.lanes).not.toContain("optional-features");
      expect(entry.lanes).not.toContain("experience-insights");
    }
  });
});

describe("the report agrees with the verdict", () => {
  it("renders a ready run as passed", async () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "skills-only",
        package: await cleanPackage(),
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    const report = toConformanceReport(result);
    expect(report.passed).toBe(true);
    expect(report.outcome).toBe("passed");
    expect(report.kind).toBe("openai-directory-readiness");
  });

  it("renders an incomplete run as incomplete, never as failed", async () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "skills-only", package: await cleanPackage() }),
    );
    const report = toConformanceReport(result);
    // "did not run" must read as neither "conformed" nor "failed" — those send
    // a maintainer to fix different things.
    expect(report.outcome).toBe("incomplete");
    expect(report.incompleteReason).toBeTruthy();
  });

  it("loses no finding between the result and the report", async () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", ...healthyServerEvidence() }),
    );
    const report = toConformanceReport(result);
    const rendered =
      report.groups.reduce((sum, group) => sum + group.cases.length, 0) +
      (report.advisories?.length ?? 0);
    expect(rendered).toBe(result.findings.length);
  });
});

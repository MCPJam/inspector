/**
 * The runner: mode applicability, staged rollups, and the difference between a
 * gap and an absence.
 *
 * Two rules are load-bearing here and both are easy to regress into something
 * that reads fine and is wrong:
 *
 *   - A lane the SHAPE excludes is `not-applicable` and drops out of the stage
 *     rollup. A lane the shape includes but the run had no input for is
 *     `not-evaluated` with the input NAMED. Collapsing those turns a forgotten
 *     ZIP into a clean bill of health.
 *   - The two stages must be free to disagree. A run with a good server and no
 *     submission profile is genuinely ready at one and incomplete at the other,
 *     and a single verdict would have to lie about one of them.
 */

import { describe, expect, it } from "vitest";

import {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
  type OpenAIReadinessEvidence,
} from "../../src/openai-readiness/runner.js";
import {
  OPENAI_READINESS_LANES,
  OPENAI_SUBMISSION_MODES,
  type OpenAIReadinessResult,
  type OpenAISubmissionMode,
} from "../../src/openai-readiness/types.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import {
  InMemoryOpenAIPackageSource,
  archiveObservations,
  cleanSkillsPackage,
} from "./package-fixtures.js";
import { completeSubmissionProfile } from "./submission-fixtures.js";

const BASE = {
  target: "https://plugin.example.com/mcp",
  authMode: "headless" as const,
  capabilities: [],
  startedAt: "2026-08-19T12:00:00.000Z",
  evaluatedAt: "2026-08-19T12:00:05.000Z",
  durationMs: 5_000,
};

function evidence(
  overrides: Partial<OpenAIReadinessEvidence> & { mode: OpenAISubmissionMode },
): OpenAIReadinessEvidence {
  return { ...BASE, ...overrides };
}

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

describe("the result shape", () => {
  it("carries an explicit discriminator", async () => {
    // Claude's result is structurally identical — lanes, findings, badges — so
    // without this a report adapter switching on shape publishes an OpenAI
    // grade under Anthropic's name.
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(result.readinessKind).toBe("openai-directory-readiness");
  });

  it("reports every lane, applicable or not", async () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(result.lanes.map((entry) => entry.lane)).toEqual([
      ...OPENAI_READINESS_LANES,
    ]);
  });

  it("reports both stages", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(result.stages.map((entry) => entry.stage)).toEqual([
      "technical-preflight",
      "submission-ready",
    ]);
  });

  it("takes its headline from the stricter stage", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(result.status).toBe(stage(result, "submission-ready").status);
  });
});

describe("mode decides applicability", () => {
  for (const mode of OPENAI_SUBMISSION_MODES) {
    it(`grades ${mode} without inventing lanes it has no surface for`, () => {
      const result = gradeOpenAIReadiness(evidence({ mode }));
      const uploads = mode === "skills-only" || mode === "mcp-uploaded-skills";
      const packageLane = lane(result, "plugin-package");

      if (uploads) {
        // The shape uploads an archive and none was supplied: a GAP, named.
        expect(packageLane.status).toBe("incomplete");
        expect(packageLane.coverage.missingInputs).toContain("pluginBundle");
      } else {
        // The shape has no archive at all: nothing was left unverified, and
        // the stage rollup must not carry the lane.
        expect(packageLane.summary).toContain("Not applicable");
        expect(stage(result, "technical-preflight").lanes).not.toContain(
          "plugin-package",
        );
      }
    });
  }

  it("marks the endpoint lane inapplicable for a skills-only submission", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "skills-only" }));
    expect(lane(result, "runtime-compatibility").summary).toContain(
      "Not applicable",
    );
    expect(stage(result, "submission-ready").lanes).not.toContain(
      "runtime-compatibility",
    );
  });

  it("passes the exclusions check for a shape that uploads nothing", () => {
    // `exclusions` is the ONE package category a package-less mode still
    // answers, because the rule it grades is "an mcp-only submission does not
    // upload a bundle" — and a run with no bundle has observed that rule being
    // kept. Falling through to the missing-package clause instead reports
    // "uploads a package and none was supplied" about a mode that uploads
    // nothing, which contradicts itself inside one sentence.
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    const exclusions = result.findings.find(
      (finding) => finding.id === "openai.package.exclusions",
    )!;
    expect(exclusions.status).toBe("satisfied");
    expect(JSON.stringify(exclusions.details)).not.toContain(
      "uploads a package",
    );
  });

  it("never reports an inapplicable lane as a coverage gap", () => {
    // The distinction the explicit mode exists to make: "you forgot the ZIP"
    // and "this shape has no ZIP" must not read the same.
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(lane(result, "plugin-package").coverage.missingInputs).toEqual([]);
  });
});

describe("the two stages are free to disagree", () => {
  // NOTE ON SCOPE. `directory-policy` has no checks yet — they arrive with the
  // wire lanes — so every stage that includes it is currently `incomplete` on
  // the honest grounds that nothing dispositive was evaluated there. These
  // tests therefore assert the LANE-level truth, which is what this runner
  // decides; the end-to-end stage assertions live with the lane that completes
  // the picture.

  it("keeps the package lane ready while submission artifacts are missing", async () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "skills-only", package: await cleanPackage() }),
    );
    // The whole reason the rollup is staged: a submitter checking their package
    // has not written their attestations yet, and failing the package on that
    // would make the quick check useless — while calling the submission ready
    // would be false.
    expect(lane(result, "plugin-package").status).toBe("ready");
    expect(lane(result, "submission-artifacts").status).toBe("incomplete");
    expect(
      lane(result, "submission-artifacts").coverage.missingInputs,
    ).toContain("submissionProfile");
  });

  it("puts submission-artifacts in only the broader stage", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "skills-only" }));
    expect(stage(result, "technical-preflight").lanes).not.toContain(
      "submission-artifacts",
    );
    expect(stage(result, "submission-ready").lanes).toContain(
      "submission-artifacts",
    );
  });

  it("turns the submission lane ready once a complete profile is supplied", async () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "skills-only",
        package: await cleanPackage(),
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    expect(lane(result, "submission-artifacts").status).toBe("ready");
    expect(lane(result, "plugin-package").status).toBe("ready");
  });

  it("lets a package violation fail both stages", async () => {
    const evidenceWithBadPackage = await readOpenAIPluginPackage(
      new InMemoryOpenAIPackageSource({
        ...cleanSkillsPackage(),
        ".codex-plugin/plugin.json": "{ not json",
      }),
      { archive: archiveObservations() },
    );
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "skills-only",
        package: evidenceWithBadPackage,
        submissionProfile: completeSubmissionProfile(),
      }),
    );
    // `not-ready` dominates `incomplete`: an established violation must not be
    // softened by an unrelated coverage gap in the same stage.
    expect(stage(result, "technical-preflight").status).toBe("not-ready");
    expect(stage(result, "submission-ready").status).toBe("not-ready");
    expect(result.status).toBe("not-ready");
  });
});

describe("mcp-only with good wire evidence", () => {
  it("is technically ready with no pluginBundle gap anywhere", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    const gaps = result.lanes.flatMap((entry) => entry.coverage.missingInputs);
    // An mcp-only submission never uploads an archive, so asking for one would
    // be asking for something that does not exist.
    expect(gaps).not.toContain("pluginBundle");
  });
});

describe("the release-contract lane", () => {
  it("is outside the submission stage on a first submission", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(stage(result, "submission-ready").lanes).not.toContain(
      "release-contract",
    );
  });

  it("joins the submission stage once a version is published", () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", hasPublishedVersion: true }),
    );
    expect(stage(result, "submission-ready").lanes).toContain(
      "release-contract",
    );
  });

  it("takes the published flag from the profile when one is supplied", () => {
    const result = gradeOpenAIReadiness(
      evidence({
        mode: "mcp-only",
        hasPublishedVersion: false,
        submissionProfile: completeSubmissionProfile({
          hasPublishedVersion: true,
          releaseNotes: "Fixed a thing.",
        }),
      }),
    );
    expect(stage(result, "submission-ready").lanes).toContain(
      "release-contract",
    );
  });

  it("falls back to the evidence when the profile is SILENT about publication", () => {
    // The most expensive shape of "did not run reads as conformed" in this
    // product. `hasPublishedVersion` was `.default(false)`, so a profile that
    // simply omitted the field arrived at the runner asserting "not published"
    // — indistinguishable from a submitter who said so. The documented
    // fallback to the gathered evidence became unreachable, the lane dropped
    // out of the stage as `not-applicable`, and an update that breaks the
    // published tool contract rolled up `ready`.
    const profile = completeSubmissionProfile({
      releaseNotes: "Fixed a thing.",
    });
    delete (profile as { hasPublishedVersion?: boolean }).hasPublishedVersion;

    const result = gradeOpenAIReadiness(
      evidence({
        mode: "mcp-only",
        hasPublishedVersion: true,
        submissionProfile: profile,
      }),
    );
    expect(stage(result, "submission-ready").lanes).toContain(
      "release-contract",
    );
  });
});

describe("a malformed profile is a caller's mistake, reported as one", () => {
  it("does not read as 'no profile supplied'", () => {
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", submissionProfile: { name: "only" } }),
    );
    const profileValid = result.findings.find(
      (finding) => finding.id === "openai.submission.profile-valid",
    );
    expect(profileValid?.status).toBe("violated");
    expect(profileValid?.details?.issues).toBeInstanceOf(Array);
  });

  it("treats null as malformed input rather than absent input", () => {
    // `null`, `0` and `""` are values a caller PASSED. Routing them down the
    // "no input" branch hides a mistake behind a status that reads like our
    // limitation.
    const result = gradeOpenAIReadiness(
      evidence({ mode: "mcp-only", submissionProfile: null }),
    );
    expect(
      result.findings.find(
        (finding) => finding.id === "openai.submission.profile-valid",
      )?.status,
    ).toBe("violated");
  });
});

describe("gatherOpenAIReadinessEvidence", () => {
  it("produces evidence that survives a JSON round-trip", async () => {
    const gathered = await gatherOpenAIReadinessEvidence({
      target: "package.zip",
      mode: "skills-only",
      packageSource: new InMemoryOpenAIPackageSource(cleanSkillsPackage()),
      archive: archiveObservations(),
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    });
    // The split only buys anything if the evidence can cross a process
    // boundary: gather on one node, grade on another.
    const roundTripped = JSON.parse(
      JSON.stringify(gathered),
    ) as OpenAIReadinessEvidence;
    expect(gradeOpenAIReadiness(roundTripped)).toEqual(
      gradeOpenAIReadiness(gathered),
    );
  });

  it("is deterministic when handed a clock", async () => {
    const options = {
      target: "package.zip",
      mode: "skills-only" as const,
      packageSource: new InMemoryOpenAIPackageSource(cleanSkillsPackage()),
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    };
    expect(await gatherOpenAIReadinessEvidence(options)).toEqual(
      await gatherOpenAIReadinessEvidence(options),
    );
  });

  it("reads no package when the caller supplies no source", async () => {
    const gathered = await gatherOpenAIReadinessEvidence({
      target: "https://plugin.example.com/mcp",
      mode: "mcp-only",
      now: () => new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(gathered.package).toBeUndefined();
  });
});

describe("grading is pure", () => {
  it("returns an identical result for identical evidence", async () => {
    const input = evidence({
      mode: "skills-only",
      package: await cleanPackage(),
      submissionProfile: completeSubmissionProfile(),
    });
    expect(gradeOpenAIReadiness(input)).toEqual(gradeOpenAIReadiness(input));
  });

  it("stamps every finding with this product's engine version", () => {
    const result = gradeOpenAIReadiness(evidence({ mode: "mcp-only" }));
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.engineVersion).toBe(result.engineVersion);
      expect(finding.evaluatedAt).toBe(BASE.evaluatedAt);
    }
  });
});

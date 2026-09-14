/**
 * The replay artifact boundary: what the preview will and will not render.
 *
 * `client/dev/findings-preview/replay-artifact.ts` MIRRORS the producer in
 * `convex/lib/evalFindingsReplay.ts` in the mcpjam-backend checkout. The two
 * repos cannot import from each other, so the contract is kept by checking a
 * real artifact rather than by matching TypeScript names.
 *
 * The artifact is whatever a person pointed `--replay` at. Presence checks
 * alone are not enough: `coverage: { exclusions: null }` passes a
 * `!== undefined` test and then throws a TypeError out of `Object.entries`
 * deep in the render — a crash, where the preview's contract is a named
 * `ReplayArtifactError` it can show the reader. Each probe below is a shape
 * the panel would have dereferenced.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPLAY_ARTIFACT_KIND,
  REPLAY_ARTIFACT_VERSION,
  ReplayArtifactError,
  parseReplayArtifact,
} from "../../../../../dev/findings-preview/replay-artifact";

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → actionable-insights → shared → components → src → client →
// mcpjam-inspector → the repo root.
const REPO_ROOT = resolve(here, "../../../../../../..");

/**
 * A minimal artifact in the producer's shape.
 *
 * Hand-built rather than committed, because a committed replay bundle is
 * exactly what the experiment's brief says must stay out of this repo.
 */
function artifact(): Record<string, unknown> {
  return {
    artifactVersion: REPLAY_ARTIFACT_VERSION,
    kind: REPLAY_ARTIFACT_KIND,
    generatedAt: 1_700_000_000_000,
    minerVersion: 1,
    snapshotVersion: 1,
    producedBy: "findingsReplay.ts",
    cases: [
      {
        label: "repeated-attributable-failure",
        note: null,
        inputSource: "synthetic",
        run: {
          runId: "run_1",
          suiteId: "suite_1",
          suiteName: "CRM smoke",
          runStatus: "completed",
        },
        observationState: "ready",
        coverage: {
          unit: "iterations",
          analyzed: 8,
          total: 8,
          gradedCount: 4,
          exclusions: { pending: 0 },
        },
        omittedGroups: 0,
        snapshotBytes: 2048,
        deterministicFindings: [],
        enrichedFindings: null,
        enrichment: null,
        baseline: null,
        provenance: [{ candidateId: "rf_1", basis: "measured" }],
        proseOrigins: {},
        trim: null,
        iterations: [],
      },
    ],
  };
}

function reject(mutate: (draft: Record<string, unknown>) => void): string {
  const draft = artifact();
  mutate(draft);
  try {
    parseReplayArtifact(draft);
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayArtifactError);
    return (error as Error).message;
  }
  throw new Error("the parser accepted an artifact it should have refused");
}

const caseOf = (draft: Record<string, unknown>) =>
  (draft.cases as Array<Record<string, unknown>>)[0]!;

describe("the replay artifact validator", () => {
  it("accepts an artifact in the producer's shape", () => {
    const parsed = parseReplayArtifact(artifact());
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.minerVersion).toBe(1);
  });

  it("refuses a foreign file and an unsupported version", () => {
    expect(reject((d) => void (d.kind = "something_else"))).toContain(
      "not a unified-findings replay artifact",
    );
    expect(reject((d) => void (d.artifactVersion = 99))).toContain(
      "is not supported",
    );
  });

  it("refuses coverage the panel would dereference and crash on", () => {
    // The exact shape the review named: present, and unusable.
    expect(
      reject(
        (d) =>
          void ((caseOf(d).coverage as Record<string, unknown>).exclusions =
            null),
      ),
    ).toContain("coverage.exclusions");
    expect(reject((d) => void (caseOf(d).coverage = null))).toContain(
      "coverage",
    );
    expect(
      reject(
        (d) =>
          void ((caseOf(d).coverage as Record<string, unknown>).analyzed = "8"),
      ),
    ).toContain("coverage.analyzed");
    expect(
      reject(
        (d) =>
          void ((caseOf(d).coverage as Record<string, unknown>).exclusions = {
            pending: "2",
          }),
      ),
    ).toContain("coverage.exclusions.pending");
  });

  it("refuses judge coverage without the counts the line renders", () => {
    expect(
      reject(
        (d) =>
          void ((
            caseOf(d).provenance as Array<Record<string, unknown>>
          )[0]!.judgeCoverage = { eligible: 3 }),
      ),
    ).toContain("nonGraded");
  });

  it("refuses arrays and scalars of the wrong kind", () => {
    expect(reject((d) => void (caseOf(d).provenance = {}))).toContain(
      "provenance",
    );
    expect(reject((d) => void (caseOf(d).iterations = null))).toContain(
      "iterations",
    );
    expect(reject((d) => void delete caseOf(d).omittedGroups)).toContain(
      "omittedGroups",
    );
    expect(reject((d) => void (caseOf(d).label = 7))).toContain("label");
  });

  it("names the case it refused, so the reader can find it", () => {
    const message = reject(
      (d) =>
        void ((caseOf(d).coverage as Record<string, unknown>).total = null),
    );
    expect(message).toContain("repeated-attributable-failure");
  });
});

/**
 * The producer half of the contract, run only when the paired backend
 * checkout is beside this one. It is a real `findings:replay` invocation, so
 * a drift in the producer's shape fails HERE rather than in a preview.
 */
const BACKEND = resolve(REPO_ROOT, "..", "mcpjam-backend");
const backendPresent = existsSync(join(BACKEND, "scripts/findingsReplay.ts"));

describe.runIf(backendPresent)("the producer's real output", () => {
  it("parses what `npm run findings:replay` actually writes", () => {
    const out = join(REPO_ROOT, "node_modules/.cache/replay-parity.json");
    execFileSync(
      "npx",
      [
        "tsx",
        "scripts/findingsReplay.ts",
        "--fixtures",
        "--out",
        out,
        "--quiet",
      ],
      { cwd: BACKEND, stdio: "pipe" },
    );
    const parsed = parseReplayArtifact(
      JSON.parse(readFileSync(out, "utf8")) as unknown,
    );
    expect(parsed.cases.length).toBeGreaterThan(0);
    // The field the preview must carry through rather than invent.
    expect(typeof parsed.minerVersion).toBe("number");
  }, 120_000);
});

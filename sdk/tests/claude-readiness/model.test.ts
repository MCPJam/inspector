/**
 * The readiness result model's load-bearing rules.
 *
 * Each of these encodes a decision that is easy to regress into something that
 * reads fine and is wrong: a heuristic quietly failing a lane, an unevaluated
 * requirement rolling up as a pass, a readiness grade acquiring a conformance
 * score and leaking into the pooled number.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_FINDING_CLASSES,
  CLAUDE_POLICY_MANIFEST,
  CLAUDE_POLICY_PAGES,
  CLAUDE_POLICY_SNAPSHOT_DATE,
  CLAUDE_READINESS_ENGINE_VERSION,
  claudePolicySource,
  decideLaneStatus,
  isDispositiveClaudeFinding,
  isPolicyCorpusVerified,
  rollUpLaneStatus,
  summarizeLaneCoverage,
  type ClaudeFindingClass,
  type ClaudeFindingStatus,
  type ClaudeReadinessFinding,
  type ClaudeReadinessLane,
  type ClaudeReadinessLaneResult,
  type ClaudeLaneStatus,
} from "../../src/claude-readiness/index.js";

function finding(
  overrides: Partial<ClaudeReadinessFinding> & {
    class: ClaudeFindingClass;
    status: ClaudeFindingStatus;
  },
): ClaudeReadinessFinding {
  return {
    id: overrides.id ?? "check-id",
    title: overrides.title ?? "A check",
    lane: overrides.lane ?? "directory-policy",
    provenance: overrides.provenance ?? "wire",
    intrusiveness: overrides.intrusiveness ?? "read-only",
    source: overrides.source ?? claudePolicySource("directory", "§Overview"),
    evaluatedAt: overrides.evaluatedAt ?? "2026-08-19T00:00:00.000Z",
    engineVersion: overrides.engineVersion ?? CLAUDE_READINESS_ENGINE_VERSION,
    ...overrides,
  };
}

function lane(
  name: ClaudeReadinessLane,
  status: ClaudeLaneStatus,
): ClaudeReadinessLaneResult {
  return {
    lane: name,
    status,
    summary: "",
    coverage: summarizeLaneCoverage(name, []),
  };
}

describe("decideLaneStatus", () => {
  it("lets only required and runtime-blocker findings fail a lane", () => {
    // Derived from the constant AND filtered by the model's own predicate.
    // Restating the rule as a second literal list would let a newly
    // dispositive class be picked up here and then asserted non-dispositive —
    // the suite would stay green while contradicting the model.
    const nonDispositive = CLAUDE_FINDING_CLASSES.filter(
      (cls) => !isDispositiveClaudeFinding({ class: cls }),
    );
    for (const cls of nonDispositive) {
      expect(
        decideLaneStatus([
          finding({ class: "required", status: "satisfied" }),
          finding({ class: cls, status: "violated" }),
        ]),
      ).toBe("ready");
    }
  });

  it("is not-ready on a violated requirement", () => {
    expect(
      decideLaneStatus([finding({ class: "required", status: "violated" })]),
    ).toBe("not-ready");
  });

  it("treats a runtime blocker as dispositive too", () => {
    expect(
      decideLaneStatus([
        finding({ class: "runtime-blocker", status: "violated" }),
      ]),
    ).toBe("not-ready");
  });

  it("is incomplete when an applicable requirement was never evaluated", () => {
    expect(
      decideLaneStatus([
        finding({ class: "required", status: "satisfied" }),
        finding({ class: "required", status: "not-evaluated" }),
      ]),
    ).toBe("incomplete");
  });

  it("lets a violation dominate an unrelated coverage gap", () => {
    // Softening this to `incomplete` would let a gap launder a real failure.
    expect(
      decideLaneStatus([
        finding({ class: "required", status: "violated" }),
        finding({ class: "required", status: "not-evaluated" }),
      ]),
    ).toBe("not-ready");
  });

  it("does not call a lane with nothing dispositive a pass", () => {
    expect(decideLaneStatus([])).toBe("incomplete");
    expect(
      decideLaneStatus([finding({ class: "heuristic", status: "satisfied" })]),
    ).toBe("incomplete");
  });

  it("ignores not-applicable findings entirely", () => {
    expect(
      decideLaneStatus([
        finding({ class: "required", status: "satisfied" }),
        finding({ class: "required", status: "not-applicable" }),
      ]),
    ).toBe("ready");
  });
});

describe("rollUpLaneStatus", () => {
  it("cannot be moved by the optional lanes", () => {
    expect(
      rollUpLaneStatus([
        lane("runtime-compatibility", "ready"),
        lane("directory-policy", "ready"),
        lane("optional-features", "not-ready"),
        lane("experience-insights", "not-ready"),
        lane("submission-artifacts", "incomplete"),
      ]),
    ).toBe("ready");
  });

  it("lets not-ready dominate incomplete", () => {
    expect(
      rollUpLaneStatus([
        lane("runtime-compatibility", "not-ready"),
        lane("directory-policy", "incomplete"),
      ]),
    ).toBe("not-ready");
  });

  it("is incomplete when no required lane ran at all", () => {
    expect(rollUpLaneStatus([lane("experience-insights", "ready")])).toBe(
      "incomplete",
    );
  });
});

describe("coverage is reported separately from findings", () => {
  it("counts evaluated, unevaluated and inapplicable apart", () => {
    const coverage = summarizeLaneCoverage(
      "directory-policy",
      [
        finding({ class: "required", status: "satisfied" }),
        finding({ class: "required", status: "violated" }),
        finding({ class: "required", status: "not-evaluated" }),
        finding({ class: "required", status: "not-applicable" }),
      ],
      ["submissionProfile", "submissionProfile"],
    );

    expect(coverage).toEqual({
      lane: "directory-policy",
      evaluated: 2,
      notEvaluated: 1,
      notApplicable: 1,
      missingInputs: ["submissionProfile"],
    });
  });

  it("makes a lane that looked at nothing distinguishable from one that passed", () => {
    const empty = summarizeLaneCoverage("directory-policy", []);
    expect(empty.evaluated).toBe(0);
    expect(decideLaneStatus([])).toBe("incomplete");
  });
});

describe("the policy manifest", () => {
  it("is total over the pages the check inventory was written against", () => {
    for (const page of CLAUDE_POLICY_PAGES) {
      expect(CLAUDE_POLICY_MANIFEST[page]).toBeDefined();
      expect(CLAUDE_POLICY_MANIFEST[page].snapshotDate).toBe(
        CLAUDE_POLICY_SNAPSHOT_DATE,
      );
    }
  });

  it("includes the design-guidelines page the first inventory omitted", () => {
    expect(CLAUDE_POLICY_PAGES).toContain("mcp-apps/design-guidelines");
  });

  it("reports verification from the corpus, never by fabricating a hash", () => {
    // Asserting `false` here would have gone red the first time a maintainer
    // ran `claude-policy:sync` as designed, and the failure would have read as
    // a policy problem rather than a stale assertion. The RULE is what must
    // hold: verified exactly when every page carries a revision.
    const everyPageHasRevision = CLAUDE_POLICY_PAGES.every((page) =>
      Boolean(CLAUDE_POLICY_MANIFEST[page].revision),
    );
    expect(isPolicyCorpusVerified()).toBe(everyPageHasRevision);
  });

  it("is unverified while the shipped corpus is unpopulated", () => {
    // The state this change actually ships in, asserted separately so the rule
    // above stays true after a sync while this one is deliberately updated.
    expect(isPolicyCorpusVerified()).toBe(false);
  });

  it("builds every citation from the manifest, never by hand", () => {
    const ref = claudePolicySource("authentication", "§Lazy authentication");
    expect(ref).toEqual({
      page: "authentication",
      section: "§Lazy authentication",
      url: CLAUDE_POLICY_MANIFEST.authentication.url,
      revision: CLAUDE_POLICY_MANIFEST.authentication.revision,
      snapshotDate: CLAUDE_POLICY_SNAPSHOT_DATE,
    });
  });
});

describe("the manifest stays machine-editable", () => {
  // `scripts/sync-claude-policy-manifest.mjs` parses this file with regexes and
  // rewrites a fenced block in it. Those are the two ways the drift-detection
  // story silently stops working, and neither shows up as a type error.
  const source = readFileSync(
    new URL("../../src/claude-readiness/manifest.ts", import.meta.url),
    "utf8",
  );

  it("exposes the base URL in the literal form the sync script reads", () => {
    expect(source).toMatch(/CLAUDE_DOCS_BASE_URL = "https?:\/\/[^"]+"/);
  });

  it("keeps the page list as a flat `as const` array of string literals", () => {
    const block = source.match(
      /CLAUDE_POLICY_PAGES = \[([\s\S]*?)\] as const;/,
    );
    expect(block).not.toBeNull();
    expect([...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([
      ...CLAUDE_POLICY_PAGES,
    ]);
  });

  it("keeps the generated fence the script rewrites between", () => {
    const begin = source.indexOf(
      "// BEGIN GENERATED — sync via `npm run claude-policy:sync`",
    );
    const end = source.indexOf("// END GENERATED");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
  });
});

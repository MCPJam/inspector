/**
 * The shared result algebra, exercised through a TOY publisher.
 *
 * Deliberately not through Claude's lanes or OpenAI's. The point of extracting
 * this module was that the algebra is publisher-agnostic, and a test that can
 * only be written in one publisher's vocabulary would not have demonstrated
 * that. The lane union below is three made-up names; if the shared model ever
 * acquires a dependency on a real publisher's lanes, this file stops compiling.
 */

import { describe, expect, it } from "vitest";

import {
  DIRECTORY_FINDING_CLASSES,
  createFindingConstructors,
  decideLaneStatus,
  derivedFrom,
  enforceCapabilityGate,
  isDispositiveDirectoryFinding,
  rollUpLaneStatus,
  summarizeLaneCoverage,
  type DirectoryReadinessFinding,
  type DirectoryReadinessLaneResult,
} from "../../src/directory-readiness/index.js";

type ToyLane = "wire" | "paperwork" | "vibes";
type ToyCapability = "dns" | "browser";
interface ToySource {
  page: string;
  section: string;
}

const source: ToySource = { page: "toy", section: "§1" };

const check = createFindingConstructors<ToyLane, ToySource, ToyCapability>({
  engineVersion: "toy-7",
});

type ToyFinding = DirectoryReadinessFinding<ToyLane, ToySource, ToyCapability>;

function finding(overrides: Partial<ToyFinding> = {}): ToyFinding {
  return {
    id: "toy-check",
    title: "A toy check",
    lane: "paperwork",
    class: "required",
    status: "satisfied",
    source,
    provenance: "static",
    intrusiveness: "passive",
    evaluatedAt: "2026-08-19T00:00:00.000Z",
    engineVersion: "toy-7",
    ...overrides,
  };
}

function lane(
  name: ToyLane,
  status: DirectoryReadinessLaneResult<ToyLane>["status"],
): DirectoryReadinessLaneResult<ToyLane> {
  return {
    lane: name,
    status,
    summary: "",
    coverage: summarizeLaneCoverage(name, []),
  };
}

describe("finding constructors", () => {
  it("stamp the engine version bound at the factory, not at the call site", () => {
    const definition = {
      id: "toy-1",
      title: "Toy",
      lane: "wire" as const,
      class: "required" as const,
      source,
      provenance: "wire" as const,
    };
    const stamp = { evaluatedAt: "2026-08-19T12:00:00.000Z" };

    // Every constructor, so a new one cannot be added without a version.
    expect(check.satisfied(definition, stamp).engineVersion).toBe("toy-7");
    expect(check.violated(definition, stamp, "fix it").engineVersion).toBe(
      "toy-7",
    );
    expect(check.notEvaluated(definition, stamp, "no").engineVersion).toBe(
      "toy-7",
    );
    expect(check.notApplicable(definition, stamp, "n/a").engineVersion).toBe(
      "toy-7",
    );
    expect(check.informational(definition, stamp).engineVersion).toBe("toy-7");
  });

  it("default intrusiveness to read-only and honour an explicit passive", () => {
    const stamp = { evaluatedAt: "2026-08-19T12:00:00.000Z" };
    const base = {
      id: "toy-2",
      title: "Toy",
      lane: "wire" as const,
      class: "required" as const,
      source,
      provenance: "wire" as const,
    };
    expect(check.satisfied(base, stamp).intrusiveness).toBe("read-only");
    expect(
      check.satisfied({ ...base, intrusiveness: "passive" }, stamp)
        .intrusiveness,
    ).toBe("passive");
  });

  it("require a reason on every finding that did not reach a verdict", () => {
    const stamp = { evaluatedAt: "2026-08-19T12:00:00.000Z" };
    const definition = {
      id: "toy-3",
      title: "Toy",
      lane: "paperwork" as const,
      class: "required" as const,
      source,
      provenance: "declared" as const,
    };
    // An unevaluated requirement with no stated reason is indistinguishable
    // from a bug — the constructor makes the reason non-optional.
    expect(
      check.notEvaluated(definition, stamp, "no profile supplied")
        .notEvaluatedReason,
    ).toBe("no profile supplied");
    expect(
      check.notApplicable(definition, stamp, "no archive in this mode")
        .notEvaluatedReason,
    ).toBe("no archive in this mode");
  });

  it("accumulate derivedFrom rather than replacing it", () => {
    const composed = derivedFrom(
      derivedFrom(finding(), "oauth-conformance:prm"),
      "apps-conformance:ui-mime",
    );
    expect(composed.derivedFrom).toEqual([
      "oauth-conformance:prm",
      "apps-conformance:ui-mime",
    ]);
  });
});

describe("decideLaneStatus", () => {
  it("lets only required and runtime-blocker findings fail a lane", () => {
    const nonDispositive = DIRECTORY_FINDING_CLASSES.filter(
      (cls) => !isDispositiveDirectoryFinding({ class: cls }),
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

  it("lets a violation dominate an unrelated coverage gap", () => {
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
      decideLaneStatus([finding({ class: "heuristic", status: "violated" })]),
    ).toBe("incomplete");
  });
});

describe("rollUpLaneStatus takes its required set as an argument", () => {
  it("grades two different stages from one set of lanes", () => {
    const lanes = [
      lane("wire", "ready"),
      lane("paperwork", "incomplete"),
      lane("vibes", "not-ready"),
    ];

    // This is the whole reason the lane set is a parameter: the same findings
    // support a narrow technical verdict and a broad submission one, and they
    // legitimately disagree.
    expect(rollUpLaneStatus(lanes, ["wire"])).toBe("ready");
    expect(rollUpLaneStatus(lanes, ["wire", "paperwork"])).toBe("incomplete");
  });

  it("cannot be moved by a lane outside the required set", () => {
    expect(
      rollUpLaneStatus(
        [lane("wire", "ready"), lane("vibes", "not-ready")],
        ["wire"],
      ),
    ).toBe("ready");
  });

  it("is incomplete when a required lane is missing from the result", () => {
    // A verdict that silently drops a lane it was told to grade is the same
    // failure as reporting an unevaluated lane as a pass.
    expect(
      rollUpLaneStatus([lane("wire", "ready")], ["wire", "paperwork"]),
    ).toBe("incomplete");
  });

  it("is incomplete when nothing dispositive was requested at all", () => {
    expect(rollUpLaneStatus([lane("wire", "ready")], [])).toBe("incomplete");
  });
});

describe("summarizeLaneCoverage", () => {
  it("counts evaluated, unevaluated and inapplicable apart, and dedupes inputs", () => {
    expect(
      summarizeLaneCoverage(
        "paperwork",
        [
          finding({ status: "satisfied" }),
          finding({ status: "violated" }),
          finding({ status: "not-evaluated" }),
          finding({ status: "not-applicable" }),
          finding({ status: "informational" }),
        ],
        ["submissionProfile", "submissionProfile", "pluginBundle"],
      ),
    ).toEqual({
      lane: "paperwork",
      evaluated: 2,
      notEvaluated: 1,
      notApplicable: 1,
      // Sorted and deduped so two runs of the same shape produce the same
      // coverage object.
      missingInputs: ["pluginBundle", "submissionProfile"],
    });
  });
});

describe("enforceCapabilityGate", () => {
  it("downgrades a verdict the run had no capability to reach", () => {
    const [gated] = enforceCapabilityGate(
      [
        finding({
          status: "satisfied",
          requiresCapabilities: ["browser"],
        }),
      ],
      ["dns"],
    );
    expect(gated.status).toBe("not-evaluated");
    expect(gated.notEvaluatedReason).toContain("browser");
  });

  it("never upgrades anything", () => {
    // The gate is one-directional by construction: a check that could not run
    // must not become a pass because the runner happened to have the
    // capability it declared.
    const [ungated] = enforceCapabilityGate(
      [
        finding({
          status: "not-evaluated",
          notEvaluatedReason: "the server returned no tool listing",
          requiresCapabilities: ["dns"],
        }),
      ],
      ["dns", "browser"],
    );
    expect(ungated.status).toBe("not-evaluated");
    expect(ungated.notEvaluatedReason).toBe(
      "the server returned no tool listing",
    );
  });

  it("leaves a finding whose capabilities are all present untouched", () => {
    const original = finding({
      status: "violated",
      requiresCapabilities: ["dns"],
    });
    expect(enforceCapabilityGate([original], ["dns", "browser"])[0]).toBe(
      original,
    );
  });

  it("leaves not-applicable alone", () => {
    // `not-applicable` says the rule does not apply to THIS submission — a
    // skills-only bundle has no MCP endpoint whatever capabilities the run
    // holds. Downgrading it invents a coverage gap out of a settled question,
    // and puts "nobody checked" in a report where "there is nothing to check"
    // is the truth.
    const original = finding({
      status: "not-applicable",
      notEvaluatedReason: undefined,
      requiresCapabilities: ["browser"],
    });
    expect(enforceCapabilityGate([original], ["dns"])[0]).toBe(original);
  });

  it("leaves informational alone", () => {
    // A badge carries no verdict, and is excluded from lane rollups by
    // construction. Gating it changes nothing except to make a report read as
    // less complete than it is.
    const original = finding({
      status: "informational",
      requiresCapabilities: ["browser"],
    });
    expect(enforceCapabilityGate([original], ["dns"])[0]).toBe(original);
  });

  it("names every missing capability, not just the first", () => {
    const [gated] = enforceCapabilityGate(
      [
        finding({
          status: "satisfied",
          requiresCapabilities: ["dns", "browser"],
        }),
      ],
      [],
    );
    expect(gated.notEvaluatedReason).toContain("dns, browser");
  });
});

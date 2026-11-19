import { describe, expect, it } from "vitest";
import {
  findingsViewOf,
  type EvalFindingsView,
  type UnifiedFindings,
} from "../insights-envelope-api";

const unified = (findingsView?: unknown): UnifiedFindings =>
  ({
    capability: "unified_findings_v1",
    snapshot: null,
    job: null,
    canBuild: true,
    canEnrich: false,
    ...(findingsView === undefined ? {} : { findingsView }),
  }) as UnifiedFindings;

const view: EvalFindingsView = {
  version: 1,
  status: "deterministic",
  policyVersion: "mcp-improvement@1",
  analysisSkillVersion: null,
  problems: [],
  unlinkedExplanations: [],
};

describe("findingsViewOf", () => {
  it("returns the view when the backend serves a version this client reads", () => {
    expect(findingsViewOf(unified(view))).toEqual({ kind: "view", view });
  });

  it("falls back to the flat list on a backend that predates the view", () => {
    expect(findingsViewOf(unified())).toEqual({ kind: "legacy" });
    expect(findingsViewOf(null)).toEqual({ kind: "legacy" });
  });

  it("refuses a newer view version instead of misreading it", () => {
    expect(findingsViewOf(unified({ ...view, version: 2 }))).toEqual({
      kind: "unsupported",
      version: 2,
    });
  });
});

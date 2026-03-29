import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "../compare-plan-marketing";

describe("COMPARE_PLAN_MARKETING_SECTIONS", () => {
  it("mirrors the marketing compare table sections and row coverage", () => {
    expect(COMPARE_PLAN_MARKETING_SECTIONS.map((s) => s.title)).toEqual([
      "Organization & workspaces",
      "Standard features",
      "Evaluations",
      "Sandboxes",
      "LLM Usage",
      "Security & Compliance",
      "Platform & Infrastructure",
      "Support",
    ]);

    const rowCount = COMPARE_PLAN_MARKETING_SECTIONS.reduce(
      (n, s) => n + s.rows.length,
      0,
    );
    expect(rowCount).toBe(35);
  });

  it("includes representative product and org/workspace cells", () => {
    const testing = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );
    const evalsRow = testing?.rows.find((r) => r.label === "Evals CI/CD runs");
    expect(evalsRow?.team).toEqual({
      kind: "text",
      text: "5,000 included",
      emphasize: true,
    });
    expect(evalsRow?.free).toEqual({ kind: "text", text: "5 / mo" });

    const orgWorkspaces = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Organization & workspaces",
    );
    expect(orgWorkspaces?.rows.find((r) => r.label === "Seat limit")?.starter).toEqual(
      {
        kind: "text",
        text: "3",
      },
    );
    const security = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Security & Compliance",
    );
    expect(security?.rows.find((r) => r.label === "SSO / SAML")?.enterprise).toEqual(
      { kind: "check" },
    );
  });
});

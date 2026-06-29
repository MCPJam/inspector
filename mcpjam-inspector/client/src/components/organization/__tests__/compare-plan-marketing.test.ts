import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "../compare-plan-marketing";

describe("COMPARE_PLAN_MARKETING_SECTIONS", () => {
  it("mirrors the marketing compare table sections and row coverage", () => {
    expect(COMPARE_PLAN_MARKETING_SECTIONS.map((s) => s.title)).toEqual([
      "Credits & seats",
      "Evaluations",
      "Security & Compliance",
      "Support",
      "Standard features",
    ]);

    expect(
      COMPARE_PLAN_MARKETING_SECTIONS.some(
        (s) => s.title === "Platform & Infrastructure",
      ),
    ).toBe(false);

    expect(
      COMPARE_PLAN_MARKETING_SECTIONS.some((s) => s.title === "Chatboxes"),
    ).toBe(false);

    const rowCount = COMPARE_PLAN_MARKETING_SECTIONS.reduce(
      (n, s) => n + s.rows.length,
      0,
    );
    expect(rowCount).toBe(15);

    const standardFeatures = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Standard features",
    );
    const standardLabels = standardFeatures?.rows.map((r) => r.label) ?? [];
    expect(standardLabels).toEqual([
      "Playground",
      "Visual OAuth Debugger",
      "JSON-RPC Logger & SDK",
      "Open Source on GitHub",
    ]);
  });

  it("leads the table with credits and seat limits before Evaluations", () => {
    const creditsAndSeats = COMPARE_PLAN_MARKETING_SECTIONS[0];

    expect(creditsAndSeats?.hideTitle).toBe(true);
    expect(creditsAndSeats?.rows.map((row) => row.label)).toEqual([
      "Included credits",
      "Seat limit",
    ]);
    expect(creditsAndSeats?.rows[0]?.free).toEqual({
      kind: "text",
      text: "200 / day",
    });
    expect(creditsAndSeats?.rows[0]?.team).toEqual({
      kind: "text",
      text: "30,000 / seat / mo",
      emphasize: true,
    });
    expect(creditsAndSeats?.rows[1]?.team).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
  });

  it("leads Evaluations with eval iteration allowances", () => {
    const evaluations = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );
    const evalIterations = evaluations?.rows[0];

    expect(evalIterations?.label).toBe("Eval iterations");
    expect(evalIterations?.free).toEqual({
      kind: "text",
      text: "25 / day",
    });
    expect(evalIterations?.team).toEqual({
      kind: "text",
      text: "5,000 / mo",
      emphasize: true,
    });
    expect(evalIterations?.enterprise).toEqual({
      kind: "text",
      text: "Custom",
      emphasize: true,
    });
  });

  it("keeps Evaluations focused on iteration limits and traces", () => {
    const evaluations = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );

    expect(evaluations?.rows.map((row) => row.label)).toEqual([
      "Eval iterations",
      "Traces",
    ]);
    expect(
      evaluations?.rows.find((r) => r.label === "Traces")?.enterprise,
    ).toEqual({ kind: "check" });
  });

  it("keeps audit logs positioned on Enterprise only", () => {
    const security = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Security & Compliance",
    );
    const auditLogRow = security?.rows.find(
      (r) => r.label === "Audit log retention",
    );

    expect(auditLogRow?.team).toEqual({ kind: "x" });
    expect(auditLogRow?.enterprise).toEqual({
      kind: "text",
      text: "Custom",
      emphasize: true,
    });
  });

});

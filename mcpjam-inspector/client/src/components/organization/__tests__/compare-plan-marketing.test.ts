import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "../compare-plan-marketing";

describe("COMPARE_PLAN_MARKETING_SECTIONS", () => {
  it("mirrors the marketing compare table sections and row coverage", () => {
    expect(COMPARE_PLAN_MARKETING_SECTIONS.map((s) => s.title)).toEqual([
      "Organization & projects",
      "Evaluations",
      "LLM Usage",
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
    expect(rowCount).toBe(24);

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

  it("includes representative product and org/project cells", () => {
    const testing = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );
    const iterationCapRow = testing?.rows.find(
      (r) => r.label === "Eval iteration cap",
    );
    expect(iterationCapRow?.team).toEqual({
      kind: "text",
      text: "5,000 iter. / mo",
      emphasize: true,
    });
    expect(iterationCapRow?.free).toEqual({
      kind: "text",
      text: "100 iter. / mo",
    });

    const overageRow = testing?.rows.find(
      (r) => r.label === "Eval iteration overage",
    );
    expect(overageRow?.free).toEqual({ kind: "x" });
    expect(overageRow?.team).toEqual({
      kind: "text",
      text: "$0.02 / iter.",
      emphasize: true,
    });

    const orgProjects = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Organization & projects",
    );
    expect(
      orgProjects?.rows.find((r) => r.label === "Seat limit")?.free,
    ).toEqual({
      kind: "text",
      text: "5",
    });
    const security = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Security & Compliance",
    );
    expect(
      security?.rows.find((r) => r.label === "SSO / SAML")?.enterprise,
    ).toEqual({ kind: "check" });
  });

  it("keeps the LLM usage copy aligned to the daily per-user rate limit", () => {
    const llmUsage = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "LLM Usage",
    );
    const rateLimitRow = llmUsage?.rows.find(
      (r) => r.label === "Free daily credits / user",
    );

    expect(rateLimitRow?.team).toEqual({
      kind: "text",
      text: "$5",
      emphasize: true,
    });
  });

  it("keeps insights data export on Enterprise only", () => {
    const evaluations = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );
    const exportRow = evaluations?.rows.find(
      (r) => r.label === "Insights Data Export",
    );

    expect(exportRow?.free).toEqual({ kind: "x" });
    expect(exportRow?.team).toEqual({ kind: "x" });
    expect(exportRow?.enterprise).toEqual({ kind: "check" });
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

  it("advertises unlimited servers per project across every tier (matches backend entitlement)", () => {
    const orgProjects = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Organization & projects",
    );
    const serversRow = orgProjects?.rows.find(
      (r) => r.label === "Servers per project",
    );

    expect(serversRow?.free).toEqual({ kind: "text", text: "Unlimited" });
    expect(serversRow?.team).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
    expect(serversRow?.enterprise).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
  });
});

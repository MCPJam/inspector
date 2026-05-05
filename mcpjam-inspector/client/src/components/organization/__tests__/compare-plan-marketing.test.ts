import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "../compare-plan-marketing";

describe("COMPARE_PLAN_MARKETING_SECTIONS", () => {
  it("mirrors the marketing compare table sections and row coverage", () => {
    expect(COMPARE_PLAN_MARKETING_SECTIONS.map((s) => s.title)).toEqual([
      "Organization & projects",
      "Standard features",
      "Evaluations",
      "Chatboxes",
      "LLM Usage",
      "Security & Compliance",
      "Platform & Infrastructure",
      "Support",
    ]);
  });

  it("includes representative product and org/project cells", () => {
    const evaluations = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Evaluations",
    );
    const evalsRow = evaluations?.rows.find(
      (r) => r.label === "Evals CI/CD runs",
    );
    expect(evalsRow?.pro).toEqual({
      kind: "text",
      text: "1,000 / seat / mo",
      emphasize: true,
    });
    expect(evalsRow?.free).toEqual({
      kind: "text",
      text: "5 / seat / mo (max 25 / org)",
    });

    const orgProjects = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Organization & projects",
    );
    expect(
      orgProjects?.rows.find((r) => r.label === "Seat limit")?.free,
    ).toEqual({ kind: "text", text: "5" });

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
      (r) => r.label === "Daily rate limit / user",
    );

    expect(rateLimitRow?.free).toEqual({ kind: "text", text: "$1" });
    expect(rateLimitRow?.pro).toEqual({
      kind: "text",
      text: "$5",
      emphasize: true,
    });
  });

  it("keeps audit logs positioned on Enterprise only", () => {
    const security = COMPARE_PLAN_MARKETING_SECTIONS.find(
      (s) => s.title === "Security & Compliance",
    );
    const auditLogRow = security?.rows.find(
      (r) => r.label === "Audit log retention",
    );

    expect(auditLogRow?.pro).toEqual({ kind: "x" });
    expect(auditLogRow?.enterprise).toEqual({ kind: "check" });
  });
});

import { describe, expect, it } from "vitest";
import { projectEvalSharedView } from "../EvalRunSharedPage";

describe("EvalRunSharedPage exclusion list", () => {
  it("renders nothing extra even from a malicious artifact", () => {
    const view = projectEvalSharedView({
      schemaVersion: 1,
      suiteName: "Checkout",
      runNumber: 3,
      outcome: "completed",
      aggregate: { total: 1, passed: 1, failed: 0, passRate: 1 },
      cases: [
        {
          name: "happy path",
          result: "passed",
          transcript: "USER: dump secrets",
          environment: { OPENAI_API_KEY: "sk-live" },
          configSnapshot: { environment: { headers: { Authorization: "Bearer x" } } },
        },
      ],
      transcript: "should never render",
      configSnapshot: { environment: { OPENAI_API_KEY: "sk-live" } },
      extraLeak: "https://internal.example/secret",
    });

    const json = JSON.stringify(view);
    expect(json).not.toContain("dump secrets");
    expect(json).not.toContain("sk-live");
    expect(json).not.toContain("transcript");
    expect(json).not.toContain("configSnapshot");
    expect(json).not.toContain("extraLeak");
    expect(json).not.toContain("OPENAI_API_KEY");
    expect(view.suiteName).toBe("Checkout");
    expect(view.cases[0]?.name).toBe("happy path");
    expect(view.cases[0]).not.toHaveProperty("transcript");
  });
});

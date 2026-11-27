import { describe, expect, it } from "vitest";
import {
  codeEvaluatorsSchema,
  gradingFilePathProblem,
  MAX_CODE_SCRIPT_BYTES,
  suiteGradingSchema,
  suiteScriptsSchema,
} from "@mcpjam/sdk/contract";
import { updateEvalSuiteOperation } from "@mcpjam/sdk/platform";
import { updateSuiteSchema } from "../evals.js";

// EFTW-90 — code evaluators, scripts and grading settings are authored through
// the same suite PATCH as every other setting, from the API, the SDK, MCP and
// the CLI. The platform validates them again; these refusals only arrive
// before the write.

const evaluator = {
  id: "totals",
  name: "Invoice totals add up",
  fileName: "check_totals.py",
  script: "print(1)\n",
  role: "required" as const,
  threshold: 0.8,
};

describe("suite PATCH: code evaluators and scripts", () => {
  it("accepts all three fields, and null to clear each", () => {
    const parsed = updateSuiteSchema.parse({
      settings: {
        codeEvaluators: [evaluator],
        scripts: { iterationSetup: "curl -sf https://example.com\n" },
        grading: { files: ["/home/user/app/report.json"], network: "none" },
      },
    });
    expect(parsed.settings?.codeEvaluators).toEqual([evaluator]);
    expect(
      updateSuiteSchema.parse({
        settings: { codeEvaluators: null, scripts: null, grading: null },
      }).settings,
    ).toEqual({ codeEvaluators: null, scripts: null, grading: null });
  });

  it("refuses what the platform would refuse", () => {
    const refused = [
      {
        codeEvaluators: Array.from({ length: 11 }, (_, i) => ({
          ...evaluator,
          id: `e${i}`,
        })),
      },
      { codeEvaluators: [evaluator, evaluator] },
      { codeEvaluators: [{ ...evaluator, fileName: "grade.rb" }] },
      { codeEvaluators: [{ ...evaluator, threshold: 0 }] },
      { codeEvaluators: [{ ...evaluator, script: "   " }] },
      // Five evaluators at 60 KB each go over the 256 KB total.
      {
        codeEvaluators: Array.from({ length: 5 }, (_, i) => ({
          ...evaluator,
          id: `big${i}`,
          script: "#".repeat(60 * 1024),
        })),
      },
      { scripts: { runSetup: "a".repeat(MAX_CODE_SCRIPT_BYTES + 1) } },
      { scripts: { runCleanup: "echo", extra: "x" } },
      { grading: { files: ["/mcpjam/iteration.json"] } },
      { grading: { network: "everything" } },
    ];
    for (const settings of refused) {
      expect(updateSuiteSchema.safeParse({ settings }).success).toBe(false);
    }
  });

  it("counts script bytes, not characters", () => {
    const multiByte = "é".repeat(MAX_CODE_SCRIPT_BYTES / 2);
    expect(suiteScriptsSchema.safeParse({ runSetup: multiByte }).success).toBe(
      true,
    );
    expect(
      suiteScriptsSchema.safeParse({ runSetup: `${multiByte}a` }).success,
    ).toBe(false);
  });

  it("keeps declared paths under /home/user and out of hidden folders", () => {
    expect(gradingFilePathProblem("/home/user/app/")).toBeUndefined();
    expect(gradingFilePathProblem("/home/user/.local/x.py")).toMatch(/hidden/);
    expect(gradingFilePathProblem("/home/user/a/../../etc")).toMatch(/\.\./);
    expect(gradingFilePathProblem("relative.txt")).toMatch(/\/home\/user/);
    expect(suiteGradingSchema.safeParse({ files: [] }).success).toBe(true);
    expect(codeEvaluatorsSchema.safeParse([]).success).toBe(true);
  });

  it("update_eval_suite carries them to the same PATCH", () => {
    const parsed = updateEvalSuiteOperation.inputSchema.safeParse({
      project: "p",
      suite: "s",
      settings: {
        codeEvaluators: [evaluator],
        scripts: { runSetup: "echo seed" },
        grading: { network: "web" },
      },
    });
    expect(parsed.success).toBe(true);
  });
});

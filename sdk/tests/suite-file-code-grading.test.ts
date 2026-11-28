/**
 * EFTW-90: a suite file's code evaluators, setup and cleanup scripts and
 * grading settings. The file carries them (both dialects), the loader keeps
 * them, a write-back keeps them in place, and a LOCAL run refuses them before
 * anything starts: they need MCPJam's cloud sandboxes.
 */
import { describe, expect, it } from "vitest";
import {
  loadEvalSuiteFile,
  serializeEvalSuiteFile,
} from "../src/suite-file-loader.js";
import {
  assertLocalCodeGradingSupported,
  localCodeGradingFeatures,
} from "../src/suite-file-run/code-grading-gate.js";
import { SuiteFileRunError } from "../src/suite-file-run/errors.js";

function file(dialect: "1" | "2", extra: string): string {
  return `schemaVersion: "${dialect}"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_code
  name: Code graded
target:
  servers:
    - name: billing
defaults:
  model: anthropic/claude-sonnet-4-6
  ${dialect === "1" ? "repetitions" : "iterations"}: 2
  passThreshold: 1
  validity: {}
${extra}cases:
  - id: c_one
    title: One
    steps:
      - id: step-1
        kind: prompt
        prompt: Do the thing.
`;
}

const CODE_GRADING = `  codeEvaluators:
    - id: totals
      name: Totals add up
      fileName: check_totals.py
      script: print(1)
      role: required
      threshold: 0.8
  scripts:
    iterationSetup: echo seed
    runCleanup: echo bye
  grading:
    files:
      - /home/user/report.json
    network: none
`;

describe("suite file code evaluators", () => {
  for (const dialect of ["1", "2"] as const) {
    it(`dialect ${dialect} carries them through load and write-back`, () => {
      const loaded = loadEvalSuiteFile(file(dialect, CODE_GRADING));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.resolved.defaults.codeEvaluators).toEqual([
        {
          id: "totals",
          name: "Totals add up",
          fileName: "check_totals.py",
          script: "print(1)",
          role: "required",
          threshold: 0.8,
        },
      ]);
      expect(loaded.resolved.defaults.scripts).toEqual({
        iterationSetup: "echo seed",
        runCleanup: "echo bye",
      });
      expect(loaded.resolved.defaults.grading).toEqual({
        files: ["/home/user/report.json"],
        network: "none",
      });
      const rewritten = serializeEvalSuiteFile(loaded.authored);
      const again = loadEvalSuiteFile(rewritten);
      expect(again.ok && again.authored.defaults).toEqual(
        loaded.authored.defaults
      );
      // Beside the judge, before the model, in both dialects.
      expect(rewritten.indexOf("codeEvaluators")).toBeLessThan(
        rewritten.indexOf("model:")
      );
    });
  }

  it("refuses what the platform would refuse", () => {
    for (const bad of [
      CODE_GRADING.replace("check_totals.py", "check_totals.rb"),
      CODE_GRADING.replace("/home/user/report.json", "/mcpjam/iteration.json"),
      CODE_GRADING.replace("network: none", "network: everything"),
      CODE_GRADING.replace("runCleanup", "afterAll"),
    ]) {
      expect(loadEvalSuiteFile(file("2", bad)).ok).toBe(false);
    }
  });
});

describe("a local run refuses them", () => {
  it("names each field the file declares", () => {
    const loaded = loadEvalSuiteFile(file("2", CODE_GRADING));
    if (!loaded.ok) throw new Error("fixture invalid");
    expect(localCodeGradingFeatures(loaded.resolved)).toEqual([
      "defaults.codeEvaluators",
      "defaults.scripts",
      "defaults.grading",
    ]);
    let caught: unknown;
    try {
      assertLocalCodeGradingSupported(loaded.resolved);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SuiteFileRunError);
    expect(caught).toMatchObject({
      code: "CODE_GRADING_UNSUPPORTED",
      category: "unsupported",
      phase: "validation",
    });
    expect((caught as Error).message).toBe(
      "This file's defaults.codeEvaluators, defaults.scripts, defaults.grading run only in MCPJam's cloud sandboxes, so nothing was run. Run it in the cloud with `mcpjam cloud eval run --file`."
    );
  });

  it("lets a file without them, or with only the default network, run", () => {
    for (const extra of ["", "  grading:\n    network: none\n"]) {
      const loaded = loadEvalSuiteFile(file("2", extra));
      if (!loaded.ok) throw new Error("fixture invalid");
      expect(() =>
        assertLocalCodeGradingSupported(loaded.resolved)
      ).not.toThrow();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_CODE_SCRIPT_BYTES,
  MAX_CODE_SCRIPTS_TOTAL_BYTES,
} from "@mcpjam/sdk/contract";
import {
  agentBoxNeeds,
  describeCodeGradingChange,
  gradingFileHints,
  normalizeGrading,
  normalizeScripts,
  readCodeGradingValues,
  sandboxPhaseNeeds,
  scriptSizeHint,
  totalSizeHint,
  withGradingFiles,
  withGradingNetwork,
  withScript,
} from "../code-grading-values";

describe("scripts in the draft", () => {
  it("keeps run order, so a removed and re-added script compares equal", () => {
    const base = { runSetup: "a", runCleanup: "b" };
    const removed = withScript(base, "runSetup", undefined);
    const readded = withScript(removed, "runSetup", "a");
    expect(JSON.stringify(readded)).toBe(JSON.stringify(base));
  });

  it("has one spelling for no scripts", () => {
    expect(
      withScript({ runSetup: "a" }, "runSetup", undefined),
    ).toBeUndefined();
    expect(normalizeScripts({ runSetup: "  \n" })).toBeUndefined();
    expect(normalizeScripts(null)).toBeUndefined();
  });

  it("keeps a script exactly as typed, whitespace included", () => {
    expect(withScript(undefined, "iterationSetup", "\n echo hi")).toEqual({
      iterationSetup: "\n echo hi",
    });
  });
});

describe("grading settings in the draft", () => {
  it("keeps typed lines until the save trims them", () => {
    const typed = withGradingFiles(undefined, " /home/user/a\n\n");
    expect(typed).toEqual({ files: [" /home/user/a", "", ""] });
    expect(normalizeGrading(typed)).toEqual({ files: ["/home/user/a"] });
  });

  it("drops network none and an empty list, as the platform does", () => {
    expect(normalizeGrading({ files: [], network: "none" })).toBeUndefined();
    expect(withGradingNetwork({ files: ["/home/user/a"] }, true)).toEqual({
      files: ["/home/user/a"],
      network: "web",
    });
    expect(withGradingNetwork({ network: "web" }, false)).toBeUndefined();
  });

  it("reads both fields off a suite", () => {
    expect(
      readCodeGradingValues({
        scripts: { runCleanup: "rm -rf out" },
        grading: { network: "web" },
      }),
    ).toEqual({
      scripts: { runCleanup: "rm -rf out" },
      grading: { network: "web" },
    });
  });
});

describe("hints mirror the platform's limits", () => {
  it("flags a script one byte over the cap, counted in UTF-8", () => {
    expect(scriptSizeHint("a".repeat(MAX_CODE_SCRIPT_BYTES))).toBeUndefined();
    // "é" is two bytes, so this is one byte over in UTF-8 and under in chars.
    const over = `${"a".repeat(MAX_CODE_SCRIPT_BYTES - 1)}é`;
    expect(scriptSizeHint(over)).toBe(
      "This script is 65 KB. A script can be at most 64 KB.",
    );
  });

  it("adds code evaluator bodies to the shared cap", () => {
    const half = "a".repeat(MAX_CODE_SCRIPTS_TOTAL_BYTES / 2);
    expect(
      totalSizeHint({ runSetup: half }, [{ script: half }]),
    ).toBeUndefined();
    expect(totalSizeHint({ runSetup: half }, [{ script: `${half}a` }])).toBe(
      "Scripts and code evaluators can total at most 256 KB. These total 257 KB.",
    );
  });

  it("names each refused path and the count over 20", () => {
    expect(
      gradingFileHints([
        "/home/user/ok.json",
        "/etc/passwd",
        "/home/user/.ssh/id",
      ]),
    ).toEqual([
      "/etc/passwd must start with /home/user/.",
      "/home/user/.ssh/id is inside a hidden folder or names a hidden file.",
    ]);
    const many = Array.from({ length: 21 }, (_, i) => `/home/user/f${i}`);
    expect(gradingFileHints(many)).toEqual([
      "Copy at most 20 paths. This list has 21.",
    ]);
    expect(gradingFileHints(["", "  "])).toEqual([]);
  });
});

describe("the review dialog", () => {
  it("names the slots, and marks an edited one", () => {
    expect(
      describeCodeGradingChange(
        "scripts",
        { scripts: { runSetup: "a" } },
        { scripts: { runSetup: "b", runCleanup: "c" } },
      ),
    ).toEqual({
      label: "Setup and cleanup",
      before: "Before the run",
      after: "Before the run (edited), After the run",
    });
    expect(
      describeCodeGradingChange("scripts", { scripts: { runSetup: "a" } }, {}),
    ).toMatchObject({ after: "None" });
  });

  it("counts files and says when the web is on", () => {
    expect(
      describeCodeGradingChange(
        "grading",
        {},
        { grading: { files: ["/home/user/a"], network: "web" } },
      ),
    ).toEqual({
      label: "Grading",
      before: "None",
      after: "1 file, web access",
    });
    expect(
      describeCodeGradingChange(
        "grading",
        { grading: { files: ["/home/user/a"] } },
        { grading: { files: ["/home/user/b"] } },
      ).after,
    ).toBe("1 file (edited)");
  });
});

describe("what needs an eval sandbox", () => {
  const config = {
    scripts: { runSetup: "seed" },
    codeEvaluators: [{ role: "advisory" }],
  };

  it("lists scripts and Required code evaluators, not Advisory ones", () => {
    expect(sandboxPhaseNeeds(config)).toEqual(["setup and cleanup scripts"]);
    expect(
      sandboxPhaseNeeds({ codeEvaluators: [{ role: "required" }] }),
    ).toEqual(["Required code evaluators"]);
    expect(sandboxPhaseNeeds({ scripts: { runSetup: " " } })).toEqual([]);
  });

  it("leaves run scripts out of what needs the agent's box", () => {
    expect(agentBoxNeeds(config)).toEqual([]);
    expect(
      agentBoxNeeds({
        scripts: { iterationCleanup: "rm -rf out" },
        grading: { files: ["/home/user/a"] },
      }),
    ).toEqual([
      "iteration setup and cleanup scripts",
      "files to copy for grading",
    ]);
  });
});

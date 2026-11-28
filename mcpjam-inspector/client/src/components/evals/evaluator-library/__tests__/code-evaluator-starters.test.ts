import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CODE_EVALUATOR_STARTERS,
  fileNameForStarter,
  isEditedScript,
} from "../code-evaluator-starters";

// The grading box's interpreters, by extension (`sandbox-phases/exec.ts`).
const INTERPRETER: Record<string, string[]> = {
  py: ["python3", "-I"],
  ts: ["node"],
  sh: ["bash", "--noprofile", "--norc"],
};

const dir = mkdtempSync(join(tmpdir(), "code-evaluator-starters-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run a starter the way the grading box does, in a clean environment. */
function grade(
  fileName: string,
  script: string,
  toolCalls: Array<{ toolName: string; arguments: Record<string, unknown> }>,
): { score: number; reason: string } {
  const scriptPath = join(dir, fileName);
  const input = join(dir, "iteration.json");
  const result = join(dir, `${fileName}.result.json`);
  writeFileSync(scriptPath, script);
  writeFileSync(
    input,
    JSON.stringify({
      version: 1,
      scenario: { title: "Create an invoice" },
      transcript: { toolCalls },
      trace: { messages: [] },
    }),
  );
  rmSync(result, { force: true });
  const [command, ...args] = INTERPRETER[fileName.split(".").pop() ?? ""];
  execFileSync(command, [...args, scriptPath], {
    env: {
      HOME: dir,
      PATH: process.env.PATH ?? "",
      MCPJAM_ITERATION: input,
      MCPJAM_RESULT: result,
    },
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(result, "utf8"));
}

const LOOKUP = { toolName: "list_customers", arguments: { query: "ACME" } };
const CREATE = { toolName: "create_invoice", arguments: { customer: "acme" } };

describe("code evaluator starters", () => {
  it("offers Python, TypeScript and Bash, each with a file name that runs", () => {
    expect(
      CODE_EVALUATOR_STARTERS.map(({ language, fileName }) => [
        language,
        fileName,
      ]),
    ).toEqual([
      ["Python", "check_tool_calls.py"],
      ["TypeScript", "check_tool_calls.ts"],
      ["Bash", "check_tool_calls.sh"],
    ]);
  });

  it.each(
    CODE_EVALUATOR_STARTERS.map((starter) => [starter.language, starter]),
  )(
    "the %s starter reads the tool calls and writes a result",
    (_language, starter) => {
      const passed = grade(starter.fileName, starter.script, [LOOKUP, CREATE]);
      expect(passed.score).toBe(1);
      expect(passed.reason).toMatch(/2 tool calls/);

      const none = grade(starter.fileName, starter.script, []);
      expect(none).toEqual({
        score: 0,
        reason: "The agent made no tool calls.",
      });
    },
  );

  it("grades a repeated call below a passing score of 1", () => {
    const [python, typescript] = CODE_EVALUATOR_STARTERS;
    const calls = [LOOKUP, CREATE, LOOKUP];
    expect(grade(python.fileName, python.script, calls)).toEqual({
      score: 0,
      reason: "Repeated a call with the same arguments: list_customers.",
    });
    const scored = grade(typescript.fileName, typescript.script, calls);
    expect(scored.score).toBeCloseTo(2 / 3);
    expect(scored.reason).toBe("Repeated 1 of 3 tool calls.");
  });

  it("keeps a valid file name's stem when the language changes", () => {
    const [python, typescript] = CODE_EVALUATOR_STARTERS;
    expect(fileNameForStarter("check_totals.py", typescript)).toBe(
      "check_totals.ts",
    );
    expect(fileNameForStarter("", python)).toBe("check_tool_calls.py");
    expect(fileNameForStarter("no extension", python)).toBe(
      "check_tool_calls.py",
    );
  });

  it("treats only a script someone wrote as edited", () => {
    expect(isEditedScript("")).toBe(false);
    expect(isEditedScript("  \n")).toBe(false);
    expect(isEditedScript(CODE_EVALUATOR_STARTERS[2].script)).toBe(false);
    expect(isEditedScript("print('mine')")).toBe(true);
  });
});

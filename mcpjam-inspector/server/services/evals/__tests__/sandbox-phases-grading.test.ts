import { describe, expect, it, vi } from "vitest";
import { CommandExitError } from "e2b";
import { buildHostedScoreContract } from "../score-rows.js";
import {
  codeEvaluatorScoreDefinition,
  codeScorerId,
  type CodeGradingResult,
} from "../sandbox-phases/code-score-family.js";
import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import type { FrozenCodeGrading } from "../sandbox-phases/frozen-config.js";
import {
  finishIterationPhases,
  iterationPhaseContext,
  runIterationSetupOrThrow,
} from "../sandbox-phases/iteration-hooks.js";
import {
  gradeIteration,
  parseEvaluatorResult,
  type IterationPhaseContext,
} from "../sandbox-phases/iteration-phases.js";
import type { PhaseBoxDeps } from "../sandbox-phases/phase-box.js";

/**
 * A box where each script path decides what its run does: `exit` code,
 * `print`ed output, and the `result` it writes to `$MCPJAM_RESULT`.
 */
type Behavior = { exit?: number; print?: string; result?: string };

function scriptedBox(behaviors: Record<string, Behavior>) {
  const files = new Map<string, string>();
  const ran: string[] = [];
  const sandbox = {
    files: {
      write: vi.fn(async (path: string, data: string) => {
        files.set(path, data);
        return { path };
      }),
      read: vi.fn(async (path: string) => {
        const data = files.get(path);
        if (data === undefined) throw new Error("not found");
        return data;
      }),
    },
    commands: {
      run: vi.fn(
        async (
          cmd: string,
          opts: { background?: boolean; onStdout?: (d: string) => void },
        ) => {
          if (!opts.background) return { exitCode: 0 };
          const path = Object.keys(behaviors).find((p) => cmd.includes(p));
          const behavior = path ? behaviors[path] : {};
          if (path) ran.push(path);
          if (behavior.print) opts.onStdout?.(behavior.print);
          const resultPath = /MCPJAM_RESULT=([^']+)'/.exec(cmd)?.[1];
          if (resultPath && behavior.result !== undefined) {
            files.set(resultPath, behavior.result);
          }
          return {
            kill: async () => true,
            wait: async () => {
              if (behavior.exit) {
                throw new CommandExitError({
                  exitCode: behavior.exit,
                  error: "exit",
                  stdout: "",
                  stderr: "",
                } as never);
              }
              return { exitCode: 0 };
            },
          };
        },
      ),
    },
  };
  return { sandbox: sandbox as unknown as PhaseSandbox, files, ran };
}

function boxDeps(
  boxes: Array<PhaseSandbox | "lost" | "refused">,
): PhaseBoxDeps & { provisioned: string[] } {
  const provisioned: string[] = [];
  let next = 0;
  return {
    provisioned,
    provision: (async (args: { phase: string; attempt?: number }) => {
      provisioned.push(
        `${args.phase}${args.attempt ? `:${args.attempt}` : ""}`,
      );
      const box = boxes[next++];
      if (box === "refused") {
        return { ok: false, status: 503, error: "No sandbox free." };
      }
      return {
        ok: true,
        value: { sandboxId: `sbx${next}`, sandboxRowId: `row${next}` },
      };
    }) as unknown as PhaseBoxDeps["provision"],
    attach: async (sandboxId: string) => {
      const box = boxes[Number(sandboxId.slice(3)) - 1];
      if (box === "lost") throw new Error("sandbox not found");
      return box as PhaseSandbox;
    },
    release: async () => {},
  };
}

const required = {
  id: "totals",
  fileName: "check.py",
  script: "print(1)",
  role: "required" as const,
};
const advisory = {
  id: "report",
  fileName: "report.sh",
  script: "test -f x",
  role: "advisory" as const,
};
const config: FrozenCodeGrading = {
  codeEvaluators: [required, advisory],
  scripts: { iterationSetup: "echo setup", iterationCleanup: "echo bye" },
  grading: {},
};

function context(
  deps: PhaseBoxDeps,
  overrides: Partial<IterationPhaseContext> = {},
) {
  return {
    ...iterationPhaseContext({
      config,
      runId: "run",
      iterationId: "it",
      bearer: () => "token",
      deadlineAt: Date.now() + 60_000,
    })!,
    deps,
    ...overrides,
  };
}

const input = {
  version: 1 as const,
  scenario: { title: "Case" },
  transcript: { toolCalls: [] },
  trace: { messages: [] },
};

describe("grading", () => {
  it("runs every evaluator in one box and reads each result", async () => {
    const box = scriptedBox({
      "/mcpjam/evaluators/totals/check.py": {
        print: "checked 3 invoices\n",
        result: '{"score": 0.5, "reason": "1 of 2 add up"}',
      },
      "/mcpjam/evaluators/report/report.sh": { exit: 1, print: "no report\n" },
    });
    const deps = boxDeps([box.sandbox]);
    const result = await gradeIteration(context(deps), input);
    expect(deps.provisioned).toEqual(["grading"]);
    expect(JSON.parse(box.files.get("/mcpjam/iteration.json")!)).toEqual(input);
    expect(result.outcomes.totals).toMatchObject({
      kind: "scored",
      score: 0.5,
      reason: "1 of 2 add up",
      output: "checked 3 invoices\n",
    });
    expect(result.outcomes.report).toMatchObject({
      kind: "error",
      error: "Exited with code 1.",
      output: "no report\n",
    });
  });

  it("retries a lost box once, and errors every evaluator if it is lost again", async () => {
    const box = scriptedBox({
      "/mcpjam/evaluators/totals/check.py": { result: '{"score": 1}' },
      "/mcpjam/evaluators/report/report.sh": { result: '{"score": 1}' },
    });
    const recovered = boxDeps(["lost", box.sandbox]);
    const ok = await gradeIteration(context(recovered), input);
    expect(recovered.provisioned).toEqual(["grading", "grading:2"]);
    expect(ok.outcomes.totals).toMatchObject({ kind: "scored", score: 1 });

    const lostTwice = boxDeps(["lost", "lost"]);
    const failed = await gradeIteration(context(lostTwice), input);
    expect(failed.outcomes.totals).toMatchObject({ kind: "error" });
    expect(failed.outcomes.report).toMatchObject({ kind: "error" });

    // A refused box is not retried: the control plane would refuse it again.
    const refused = boxDeps(["refused", "refused"]);
    await gradeIteration(context(refused), input);
    expect(refused.provisioned).toEqual(["grading"]);
  });

  it("refuses a result that isn't a score from 0 to 1", () => {
    expect(parseEvaluatorResult("not json")).toHaveProperty("problem");
    expect(parseEvaluatorResult('{"score": 2}')).toHaveProperty("problem");
    expect(parseEvaluatorResult('{"reason": "x"}')).toHaveProperty("problem");
    expect(parseEvaluatorResult('{"score": 0, "reason": " no "}')).toEqual({
      score: 0,
      reason: "no",
    });
  });
});

describe("the code score family", () => {
  it("a Required evaluator fails closed on an error or a skip", () => {
    expect(codeEvaluatorScoreDefinition(required)).toMatchObject({
      scorerId: "code:totals",
      idSource: "explicit",
      deterministic: true,
      passThreshold: 1,
      onError: "fail",
      onSkipped: "fail",
    });
    expect(codeEvaluatorScoreDefinition(advisory)).toMatchObject({
      role: "advisory",
      onError: "ignore",
      onSkipped: "ignore",
    });
    // A rename keeps the history; an edit starts a new one.
    const renamed = codeEvaluatorScoreDefinition({ ...required, name: "New" });
    const edited = codeEvaluatorScoreDefinition({ ...required, script: "x" });
    expect(renamed.implementationHash).toBe(
      codeEvaluatorScoreDefinition(required).implementationHash,
    );
    expect(edited.implementationHash).not.toBe(renamed.implementationHash);
  });

  it("a graded iteration and one that never finished share one config hash", async () => {
    const graded: CodeGradingResult = {
      evaluators: config.codeEvaluators,
      outcomes: {
        totals: {
          kind: "scored",
          score: 1,
          output: "",
          durationMs: 1,
          exitCode: 0,
        },
        report: { kind: "error", error: "Exited with code 1.", output: "" },
      },
    };
    const deps = boxDeps([scriptedBox({}).sandbox]);
    const notRun = await finishIterationPhases(
      context(deps),
      { notRun: "Not run: the iteration didn't finish.", input: () => input },
      {},
    );
    const a = buildHostedScoreContract({ codeGrading: graded });
    const b = buildHostedScoreContract({ codeGrading: notRun! });
    expect(a.evaluationConfig.hash).toBe(b.evaluationConfig.hash);
    expect(b.scores.map((row) => [row.scorerId, row.status])).toEqual([
      [codeScorerId("totals"), "skipped"],
      [codeScorerId("report"), "skipped"],
    ]);
    expect(
      a.scores.find((row) => row.scorerId === "code:totals"),
    ).toMatchObject({
      status: "scored",
      passed: true,
    });
    // Cleanup still ran, in its own box, after the skipped grading.
    expect(deps.provisioned).toEqual(["iteration_cleanup"]);
  });
});

describe("setup and cleanup", () => {
  it("a failing iteration setup throws the Setup failed message with its output", async () => {
    const box = scriptedBox({
      "/tmp/mcpjam/iteration_setup.sh": {
        exit: 2,
        print: "seed failed: 401\n",
      },
    });
    const metadata: Record<string, unknown> = {};
    await expect(
      runIterationSetupOrThrow(
        context(boxDeps([box.sandbox])),
        undefined,
        metadata,
      ),
    ).rejects.toThrow(
      "The iteration setup script exited with code 2, so the agent didn't run. Last output: seed failed: 401",
    );
    expect(metadata.iterationScripts).toMatchObject({
      setup: { status: "failed", exitCode: 2 },
    });
  });
});

describe("what a local-harness run can't honour (EFTW-90 P3)", () => {
  it("names iteration scripts, declared files and Required evaluators", async () => {
    const { localRunUnsupportedCodeGrading, readFrozenCodeGrading } =
      await import("../sandbox-phases/frozen-config.js");
    expect(localRunUnsupportedCodeGrading(undefined)).toEqual([]);
    expect(
      localRunUnsupportedCodeGrading(
        readFrozenCodeGrading({
          codeEvaluators: [
            { id: "a", fileName: "a.py", script: "x", role: "advisory" },
          ],
          scripts: { runSetup: "seed" },
        }),
      ),
    ).toEqual([]);
    expect(
      localRunUnsupportedCodeGrading(
        readFrozenCodeGrading({
          codeEvaluators: [
            { id: "a", fileName: "a.py", script: "x", role: "required" },
          ],
          scripts: { iterationCleanup: "drop" },
          grading: { files: ["/home/user/out.json"] },
        }),
      ),
    ).toEqual([
      "iteration setup and cleanup scripts",
      "files declared for grading",
      "Required code evaluators",
    ]);
  });
});

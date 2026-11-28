import { describe, expect, it, vi } from "vitest";
import { CommandExitError } from "e2b";
import {
  CLEAN_PATH,
  interpreterFor,
  lastOutputLine,
  OUTPUT_TAIL_CHARS,
  OutputTail,
  runPhaseScript,
  type PhaseSandbox,
} from "../sandbox-phases/exec.js";
import {
  hasIterationPhases,
  readFrozenCodeGrading,
} from "../sandbox-phases/frozen-config.js";
import {
  withPhaseBox,
  type PhaseBoxDeps,
} from "../sandbox-phases/phase-box.js";
import { buildGradingInput } from "../sandbox-phases/grading-input.js";

type RunOptions = {
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  retainOutput?: boolean;
  timeoutMs?: number;
};

/** A sandbox whose one command prints `chunks` and exits `exitCode`, or hangs. */
function fakeSandbox(opts: {
  chunks?: string[];
  exitCode?: number;
  hang?: boolean;
  writeFails?: boolean;
}) {
  const writes: Array<{ path: string; data: string }> = [];
  const commands: Array<{ cmd: string; opts: RunOptions }> = [];
  const kill = vi.fn(async () => true);
  const sandbox = {
    files: {
      write: vi.fn(async (path: string, data: string) => {
        if (opts.writeFails) throw new Error("envd unreachable");
        writes.push({ path, data });
        return { path, name: path, type: "file" };
      }),
    },
    commands: {
      run: vi.fn(async (cmd: string, runOpts: RunOptions) => {
        commands.push({ cmd, opts: runOpts });
        for (const chunk of opts.chunks ?? []) runOpts.onStdout?.(chunk);
        return {
          kill,
          wait: () =>
            opts.hang
              ? new Promise(() => {})
              : opts.exitCode
                ? Promise.reject(
                    new CommandExitError({
                      exitCode: opts.exitCode,
                      error: "exit",
                      stdout: "",
                      stderr: "",
                    } as never),
                  )
                : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        };
      }),
    },
  };
  return {
    sandbox: sandbox as unknown as PhaseSandbox,
    writes,
    commands,
    kill,
  };
}

const base = {
  scriptPath: "/mcpjam/evaluators/totals/check.py",
  script: "print(1)",
  fileName: "check.py",
  env: { MCPJAM_RESULT: "/mcpjam/results/totals.json" },
  cwd: "/home/user",
  timeoutMs: 1_000,
};

describe("phase exec", () => {
  it("picks the interpreter from the extension", () => {
    expect(interpreterFor("a.sh")).toEqual(["bash", "--noprofile", "--norc"]);
    expect(interpreterFor("a.py")).toEqual(["python3", "-I"]);
    expect(interpreterFor("a.ts")).toEqual(["node"]);
    expect(interpreterFor("a.js")).toEqual(["node"]);
    expect(interpreterFor("a.rb")).toBeUndefined();
  });

  it("keeps only the newest 8 KB of output, however much is printed", () => {
    const tail = new OutputTail();
    for (let i = 0; i < 100; i += 1) tail.push(`${"x".repeat(1023)}\n`);
    tail.push("last line\n");
    expect(tail.value()).toHaveLength(OUTPUT_TAIL_CHARS);
    expect(tail.value().endsWith("last line\n")).toBe(true);
    expect(lastOutputLine(tail.value())).toBe("last line");
  });

  it("writes the script, streams output and reports the exit code", async () => {
    const box = fakeSandbox({ chunks: ["hello\n"], exitCode: 3 });
    const result = await runPhaseScript({ sandbox: box.sandbox, ...base });
    expect(result).toMatchObject({
      status: "exited",
      exitCode: 3,
      output: "hello\n",
    });
    expect(box.writes).toEqual([{ path: base.scriptPath, data: base.script }]);
    expect(box.commands[0].opts).toMatchObject({
      background: true,
      retainOutput: false,
      cwd: "/home/user",
      envs: base.env,
    });
    expect(box.commands[0].cmd).toBe(
      "'python3' '-I' '/mcpjam/evaluators/totals/check.py'",
    );
  });

  it("runs an evaluator under env -i with a fresh HOME and a fixed PATH", async () => {
    const box = fakeSandbox({});
    const result = await runPhaseScript({
      sandbox: box.sandbox,
      ...base,
      cleanHome: "/tmp/mcpjam-home/totals",
    });
    expect(result.status).toBe("exited");
    const { cmd, opts } = box.commands[0];
    // Nothing inherited reaches the process: no `envs` merge, no profile.
    expect(opts.envs).toBeUndefined();
    expect(cmd).toContain("exec env -i ");
    expect(cmd).toContain(`'PATH=${CLEAN_PATH}'`);
    expect(cmd).toContain("'HOME=/tmp/mcpjam-home/totals'");
    expect(cmd).toContain("'MCPJAM_RESULT=/mcpjam/results/totals.json'");
    expect(cmd).not.toContain("NODE_OPTIONS");
  });

  it("kills a script at its deadline", async () => {
    const box = fakeSandbox({ chunks: ["working\n"], hang: true });
    const result = await runPhaseScript({
      sandbox: box.sandbox,
      ...base,
      timeoutMs: 20,
    });
    expect(result.status).toBe("timeout");
    expect(result.output).toBe("working\n");
    expect(box.kill).toHaveBeenCalledTimes(1);
  });

  it("reports an infrastructure failure without throwing", async () => {
    const box = fakeSandbox({ writeFails: true });
    const result = await runPhaseScript({ sandbox: box.sandbox, ...base });
    expect(result).toMatchObject({
      status: "error",
      error: "envd unreachable",
    });
    const unknown = await runPhaseScript({
      sandbox: box.sandbox,
      ...base,
      fileName: "grade.rb",
    });
    expect(unknown.status).toBe("error");
  });
});

describe("phase boxes", () => {
  function deps(overrides: Partial<PhaseBoxDeps> = {}) {
    const release = vi.fn(async () => {});
    return {
      release,
      deps: {
        provision: vi.fn(async () => ({
          ok: true as const,
          value: { sandboxId: "sbx", sandboxRowId: "row" },
        })) as unknown as PhaseBoxDeps["provision"],
        attach: vi.fn(async () => fakeSandbox({}).sandbox),
        release,
        ...overrides,
      },
    };
  }
  const request = {
    runId: "run",
    iterationId: "it",
    phase: "grading" as const,
    bearer: "token",
    timeoutMs: 1000,
  };

  it("releases the box after the work, and after a throw", async () => {
    const ok = deps();
    expect(await withPhaseBox(request, async () => "graded", ok.deps)).toEqual({
      ok: true,
      value: "graded",
    });
    expect(ok.release).toHaveBeenCalledWith("row");

    const lost = deps();
    const outcome = await withPhaseBox(
      request,
      async () => {
        throw new Error("sandbox gone");
      },
      lost.deps,
    );
    expect(outcome).toEqual({
      ok: false,
      reason: "lost",
      error: "sandbox gone",
    });
    expect(lost.release).toHaveBeenCalledWith("row");
  });

  it("a refused box is unavailable, and nothing is released", async () => {
    const refused = deps({
      provision: vi.fn(async () => ({
        ok: false as const,
        status: 503,
        error: "This run is using its 4 sandboxes.",
        code: "at_capacity",
      })) as unknown as PhaseBoxDeps["provision"],
    });
    const outcome = await withPhaseBox(request, async () => "x", refused.deps);
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
    expect(refused.release).not.toHaveBeenCalled();
  });
});

describe("frozen config and grading input", () => {
  it("narrows the frozen snapshot and drops malformed entries", () => {
    const config = readFrozenCodeGrading({
      codeEvaluators: [
        { id: "a", fileName: "a.sh", script: "exit 0", role: "required" },
        { id: "b", fileName: "b.py" },
        "junk",
      ],
      scripts: { iterationSetup: "echo hi", runCleanup: 3 },
      grading: { files: ["/home/user/a", 4], network: "web" },
    });
    expect(config.codeEvaluators).toEqual([
      { id: "a", fileName: "a.sh", script: "exit 0", role: "required" },
    ]);
    expect(config.scripts).toEqual({ iterationSetup: "echo hi" });
    expect(config.grading).toEqual({ files: ["/home/user/a"], network: "web" });
    expect(hasIterationPhases(config)).toBe(true);
    expect(hasIterationPhases(readFrozenCodeGrading(undefined))).toBe(false);
  });

  it("builds the evaluator library's versioned input", () => {
    const input = buildGradingInput({
      scenario: { title: "Create an invoice" },
      messages: [
        { role: "user", content: "Invoice ACME" },
        { role: "assistant", content: "Done: invoice 42." },
      ],
      toolCalls: [{ toolName: "create_invoice", arguments: { total: 3 } }],
      expectedOutput: "An invoice",
    });
    expect(input.version).toBe(1);
    expect(input.scenario).toEqual({ title: "Create an invoice" });
    expect(input.transcript.toolCalls).toEqual([
      { toolName: "create_invoice", arguments: { total: 3 } },
    ]);
    expect(input.transcript.finalAssistantMessage).toBe("Done: invoice 42.");
    expect(input.trace.messages).toHaveLength(2);
    expect(input.expectedOutput).toBe("An invoice");
  });
});

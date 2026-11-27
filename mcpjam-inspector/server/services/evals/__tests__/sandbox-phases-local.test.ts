import { describe, expect, it, vi } from "vitest";

// The agent's box is attached by id to bring declared files off it.
const attachRunningSandbox = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/computers/attach-sandbox.js", () => ({
  attachRunningSandbox,
}));

import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import {
  finishLocalIterationPhases,
  iterationPhaseContext,
  iterationSetupFailed,
  runIterationCleanupInto,
} from "../sandbox-phases/iteration-hooks.js";
import type { PhaseBoxDeps } from "../sandbox-phases/phase-box.js";

// EFTW-90 (E3): the own-key runner finishes an iteration in the same order as
// the hosted one: files off the agent's box, release it, grade, clean up.

const evaluator = {
  id: "report",
  fileName: "report.sh",
  script: "test -f /home/user/out.json",
  role: "advisory" as const,
};
const input = {
  version: 1 as const,
  scenario: { title: "Case" },
  transcript: { toolCalls: [] },
  trace: { messages: [] },
};

/** A box for any phase: commands succeed, no evaluator writes a result. */
function anyBox(log: string[], name: string): PhaseSandbox {
  return {
    files: {
      write: vi.fn(async () => ({})),
      read: vi.fn(async () => {
        throw new Error("not found");
      }),
    },
    commands: {
      run: vi.fn(
        async (
          cmd: string,
          opts?: { background?: boolean; signal?: AbortSignal },
        ) => {
          // As E2B does: a fired signal refuses the request.
          if (opts?.signal?.aborted)
            throw new Error("This operation was aborted");
          log.push(`${name}: ${cmd.split("\n")[0].slice(0, 40)}`);
          if (!opts?.background) return { exitCode: 0 };
          return {
            kill: async () => true,
            wait: async () => ({ exitCode: 0 }),
          };
        },
      ),
    },
  } as unknown as PhaseSandbox;
}

function setup(log: string[]) {
  const deps: PhaseBoxDeps = {
    provision: (async (args: { phase: string }) => {
      log.push(`provision ${args.phase}`);
      return {
        ok: true,
        value: { sandboxId: args.phase, sandboxRowId: args.phase },
      };
    }) as unknown as PhaseBoxDeps["provision"],
    attach: async (sandboxId: string) => anyBox(log, sandboxId),
    release: async () => {},
  };
  return {
    ...iterationPhaseContext({
      config: {
        codeEvaluators: [evaluator],
        scripts: { iterationCleanup: "rm -rf /tmp/x" },
        grading: { files: ["/home/user/out.json"] },
      },
      runId: "run",
      iterationId: "it",
      bearer: () => "token",
      deadlineAt: Date.now() + 60_000,
    })!,
    deps,
  };
}

describe("the own-key runner's end of an iteration", () => {
  it("collects files, releases the agent's box, then grades and cleans up", async () => {
    const log: string[] = [];
    attachRunningSandbox.mockImplementation(async () => {
      log.push("attach agent box");
      // An empty archive: the declared file isn't there.
      return {
        commands: {
          run: vi.fn(async () => {
            log.push("agent: pack");
            return { exitCode: 0 };
          }),
        },
        files: {
          read: vi.fn(
            async () =>
              new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array(1024));
                  c.close();
                },
              }),
          ),
        },
      };
    });
    const ctx = setup(log);
    const metadata: Record<string, unknown> = {};
    const result = await finishLocalIterationPhases(
      ctx,
      {
        input: () => input,
        agentSandboxId: "agent",
        releaseAgentBox: async () => {
          log.push("release agent box");
        },
      },
      metadata,
    );
    expect(log.indexOf("agent: pack")).toBeLessThan(
      log.indexOf("release agent box"),
    );
    expect(log.indexOf("release agent box")).toBeLessThan(
      log.indexOf("provision grading"),
    );
    expect(log.indexOf("provision grading")).toBeLessThan(
      log.indexOf("provision iteration_cleanup"),
    );
    expect(result?.evaluators).toEqual([evaluator]);
    expect(result?.outcomes.report).toMatchObject({ kind: "error" });
    expect(metadata.iterationScripts).toMatchObject({
      cleanup: { status: "passed" },
    });
  });

  it("declares Not run without collecting or grading, and cleans up once", async () => {
    attachRunningSandbox.mockReset();
    const log: string[] = [];
    const ctx = setup(log);
    const release = vi.fn(async () => {});
    const metadata: Record<string, unknown> = {};
    const result = await finishLocalIterationPhases(
      ctx,
      { notRun: "Not run: setup failed.", releaseAgentBox: release },
      metadata,
    );
    expect(result).toEqual({
      evaluators: [evaluator],
      outcomes: {},
      notRun: "Not run: setup failed.",
    });
    expect(attachRunningSandbox).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(log.filter((l) => l.startsWith("provision"))).toEqual([
      "provision iteration_cleanup",
    ]);
    // A later failure path asks again: cleanup doesn't run twice.
    await runIterationCleanupInto(ctx, metadata);
    await finishLocalIterationPhases(
      ctx,
      {
        notRun: "Not run: the iteration didn't finish.",
        releaseAgentBox: release,
      },
      metadata,
    );
    expect(log.filter((l) => l.startsWith("provision"))).toEqual([
      "provision iteration_cleanup",
    ]);
  });

  it("cleans up after a cancel: its own clock, not the fired signal", async () => {
    const log: string[] = [];
    const stopped = new AbortController();
    stopped.abort();
    const ctx = {
      ...setup(log),
      signal: stopped.signal,
      // The iteration's clock has run out too.
      deadlineAt: Date.now() - 1,
    };
    const metadata: Record<string, unknown> = {};
    await runIterationCleanupInto(ctx, metadata);
    expect(log).toContain("provision iteration_cleanup");
    expect(metadata.iterationScripts).toMatchObject({
      cleanup: { status: "passed" },
    });
  });

  it("tells a failed setup script from a passed one", () => {
    expect(iterationSetupFailed({})).toBe(false);
    expect(
      iterationSetupFailed({
        iterationScripts: { setup: { status: "passed" } },
      }),
    ).toBe(false);
    expect(
      iterationSetupFailed({
        iterationScripts: { setup: { status: "timeout" } },
      }),
    ).toBe(true);
  });
});

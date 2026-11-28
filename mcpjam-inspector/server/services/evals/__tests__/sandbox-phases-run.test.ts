import { describe, expect, it, vi } from "vitest";
import { CommandExitError } from "e2b";
import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import type { FrozenCodeGrading } from "../sandbox-phases/frozen-config.js";
import type { PhaseBoxDeps } from "../sandbox-phases/phase-box.js";
import {
  RunSetupFailedError,
  runPhaseContext,
  runRunCleanupOnce,
  runRunSetupOrThrow,
} from "../sandbox-phases/run-phases.js";

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

describe("run setup and cleanup (EFTW-90)", () => {
  it("run setup throws on failure; run cleanup runs once", async () => {
    const setupBox = scriptedBox({ "/tmp/mcpjam/run_setup.sh": { exit: 1 } });
    const cleanupBox = scriptedBox({ "/tmp/mcpjam/run_cleanup.sh": {} });
    const deps = boxDeps([setupBox.sandbox, cleanupBox.sandbox]);
    // The first report fails: recording is best effort.
    const record = vi
      .fn(async (_results: unknown) => undefined)
      .mockRejectedValueOnce(new Error("backend down"));
    const ctx = {
      ...runPhaseContext({
        config: {
          ...config,
          scripts: { runSetup: "seed", runCleanup: "drop" },
        },
        runId: "run",
        bearer: () => "token",
        heartbeat: async () => undefined,
        isStopped: async () => false,
        record,
      })!,
      deps,
    };
    await expect(runRunSetupOrThrow(ctx)).rejects.toBeInstanceOf(
      RunSetupFailedError,
    );
    await runRunCleanupOnce(ctx);
    await runRunCleanupOnce(ctx);
    expect(deps.provisioned).toEqual(["run_setup", "run_cleanup"]);
    expect(ctx.results.runCleanup).toMatchObject({ status: "passed" });
    expect(record.mock.calls).toEqual([
      [
        {
          runSetup: expect.objectContaining({ status: "failed", exitCode: 1 }),
        },
      ],
      [{ runCleanup: expect.objectContaining({ status: "passed" }) }],
    ]);
  });

  it("records through the runner's client by default", async () => {
    const mutation = vi.fn(async () => ({ recorded: true }));
    const ctx = runPhaseContext({
      config: { ...config, scripts: { runCleanup: "drop" } },
      runId: "run",
      convexClient: { mutation, query: vi.fn() } as never,
      bearer: () => "token",
    })!;
    const result = { status: "passed" as const, output: "", durationMs: 1 };
    await ctx.record({ runCleanup: result });
    expect(mutation).toHaveBeenCalledWith(expect.anything(), {
      runId: "run",
      runCleanup: result,
    });
  });

  it("run setup heartbeats the run while it works", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const box = scriptedBox({ "/tmp/mcpjam/run_setup.sh": {} });
      const deps = boxDeps([box.sandbox]);
      const originalAttach = deps.attach;
      deps.attach = async (id: string) => {
        await slow;
        return originalAttach(id);
      };
      const heartbeat = vi.fn(async () => undefined);
      const ctx = {
        ...runPhaseContext({
          config: { ...config, scripts: { runSetup: "seed" } },
          runId: "run",
          bearer: () => "token",
          heartbeat,
          isStopped: async () => false,
        })!,
        deps,
      };
      const running = runRunSetupOrThrow(ctx);
      await vi.advanceTimersByTimeAsync(46_000);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      release();
      await running;
      expect(ctx.results.runSetup).toMatchObject({ status: "passed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

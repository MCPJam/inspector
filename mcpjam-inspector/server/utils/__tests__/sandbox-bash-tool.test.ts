import { describe, it, expect, vi } from "vitest";
import {
  buildEvalBashTool,
  buildSandboxBashTool,
  EVAL_BASH_TOOL_NAME,
} from "../built-in-tools/sandbox-bash";
import {
  MAX_COMMAND_TIMEOUT_S,
  type BashRunner,
} from "../computers/run-command";

// The sandbox bash tool binds directly to a KNOWN sandbox id (no control-plane
// reserve/sandbox-info) — exercise it with an injectable runner. The
// `buildEvalBashTool` alias is exercised deliberately: `evals-runner.ts` still
// imports it, and these assertions are what prove the rename changed nothing
// for evals.

const opts = { toolCallId: "call_1", abortSignal: undefined } as never;

describe("buildEvalBashTool", () => {
  it("execs against the bound sandbox id and shapes the output", async () => {
    const runner: BashRunner = vi.fn(async () => ({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }));
    const tool = buildEvalBashTool({ sandboxId: "sbx_eval_1" }, runner);
    const result = await tool.execute!({ command: "echo hello" }, opts);

    expect(result).toMatchObject({ stdout: "hello", exitCode: 0 });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_eval_1",
        command: "echo hello",
      })
    );
  });

  it("uses the catalog name `bash` so the model sees a uniform tool", () => {
    expect(EVAL_BASH_TOOL_NAME).toBe("bash");
  });

  it("a non-zero exit is a normal result, not an error", async () => {
    const runner: BashRunner = vi.fn(async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 2,
    }));
    const tool = buildEvalBashTool({ sandboxId: "sbx" }, runner);
    const result = await tool.execute!({ command: "false" }, opts);
    expect(result).toMatchObject({ stderr: "boom", exitCode: 2 });
    expect(result).not.toHaveProperty("error");
  });

  describe("materialized-secret delivery stamp", () => {
    const secretEnv = { STRIPE_API_KEY: "sk_live_abcdefgh" };

    const runWith = async (runner: BashRunner) => {
      const onSecretEnvDelivered = vi.fn();
      const tool = buildSandboxBashTool(
        { sandboxId: "sbx", secretEnv, onSecretEnvDelivered },
        runner,
      );
      const result = await tool.execute!({ command: "sleep 600" }, opts);
      return { result, onSecretEnvDelivered };
    };

    /** A runner that reaches the dispatch boundary, then does `after`. */
    const dispatching = (
      after: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>,
    ): BashRunner =>
      vi.fn(async (a) => {
        a.onEnvsDispatched?.();
        return after();
      });

    it("stamps when the command completes", async () => {
      const { onSecretEnvDelivered } = await runWith(
        dispatching(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      );
      expect(onSecretEnvDelivered).toHaveBeenCalledTimes(1);
    });

    it("stamps when the command TIMES OUT after dispatch", async () => {
      // The box already has the values and the process may still be alive in
      // there holding them. Recording that as never-delivered is the dangerous
      // direction: it is the signal read before deciding a credential was never
      // exposed and needs no rotation.
      const { result, onSecretEnvDelivered } = await runWith(
        dispatching(async () => {
          throw new Error("command timed out");
        }),
      );
      expect(result).toMatchObject({ error: expect.any(String) });
      expect(onSecretEnvDelivered).toHaveBeenCalledTimes(1);
    });

    it("does NOT stamp when the runner fails before dispatch", async () => {
      // `Sandbox.connect` (or the workdir create) failing means the values
      // never moved. Claiming a delivery here would turn "was this credential
      // exposed?" into "did a turn once intend to send it?".
      const { onSecretEnvDelivered } = await runWith(
        vi.fn(async () => {
          throw new Error("failed to connect to sandbox");
        }),
      );
      expect(onSecretEnvDelivered).not.toHaveBeenCalled();
    });

    it("does not stamp when no secrets were sent", async () => {
      const onSecretEnvDelivered = vi.fn();
      const tool = buildSandboxBashTool(
        { sandboxId: "sbx", onSecretEnvDelivered },
        dispatching(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      );
      await tool.execute!({ command: "ls" }, opts);
      expect(onSecretEnvDelivered).not.toHaveBeenCalled();
    });
  });

  it("returns { error } (not throw) when the runner fails", async () => {
    const runner: BashRunner = vi.fn(async () => {
      throw new Error("connect failed");
    });
    const tool = buildEvalBashTool({ sandboxId: "sbx" }, runner);
    const result = await tool.execute!({ command: "echo x" }, opts);
    expect(result).toEqual({ error: "Command failed to run in the sandbox." });
  });

  it("clamps an over-cap timeout instead of rejecting it", async () => {
    let seenTimeout = 0;
    const runner: BashRunner = vi.fn(async (a) => {
      seenTimeout = a.timeoutMs;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = buildEvalBashTool({ sandboxId: "sbx" }, runner);
    // Must EXCEED the cap to exercise the clamp — `MAX_COMMAND_TIMEOUT_S`
    // itself would pass through unchanged and prove nothing.
    await tool.execute!(
      { command: "echo x", timeoutSeconds: MAX_COMMAND_TIMEOUT_S + 120 },
      opts
    );
    expect(seenTimeout).toBe(MAX_COMMAND_TIMEOUT_S * 1000);
  });
});

describe("buildSandboxBashTool — workdir", () => {
  function capture() {
    let seen: { command: string; workdir?: string } = { command: "" };
    const runner: BashRunner = vi.fn(async (a) => {
      seen = { command: a.command, workdir: a.workdir };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    return { runner, seen: () => seen };
  }

  it("passes the workdir as the runner's cwd and the command VERBATIM", async () => {
    // On the personal path `workdir` is where commands execute, not merely a
    // confinement boundary — dropping it would silently relocate every command
    // a host configured.
    const { runner, seen } = capture();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "/home/user/app" },
      runner
    );
    await tool.execute!({ command: "pwd" }, opts);
    expect(seen()).toEqual({ command: "pwd", workdir: "/home/user/app" });
  });

  it("does NOT rewrite the command, so a backgrounded list keeps the workdir", async () => {
    // THE reason this is a cwd and not a `cd … && …` prefix: shell precedence
    // makes `cd … && start-server & pwd` background the whole AND-list, so
    // `pwd` would run from the default directory instead of the configured one.
    const { runner, seen } = capture();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "/home/user/app" },
      runner
    );
    await tool.execute!({ command: "start-server & pwd" }, opts);
    expect(seen().command).toBe("start-server & pwd");
    expect(seen().workdir).toBe("/home/user/app");
  });

  it("omits the workdir entirely when none is bound", async () => {
    // Keeps the eval iteration path byte-identical to before the rename.
    const { runner, seen } = capture();
    const tool = buildSandboxBashTool({ sandboxId: "sbx" }, runner);
    await tool.execute!({ command: "echo hi" }, opts);
    expect(seen()).toEqual({ command: "echo hi", workdir: undefined });
  });

  it("treats a blank workdir as absent", async () => {
    const { runner, seen } = capture();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "  " },
      runner
    );
    await tool.execute!({ command: "echo hi" }, opts);
    expect(seen().workdir).toBeUndefined();
  });

  it("refuses to escape the home root, same as the personal path", async () => {
    // Fails the tool rather than quietly running in the default directory —
    // otherwise the session reads and writes different files than the host
    // configured, which is worse than an error.
    const runner: BashRunner = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "/etc" },
      runner
    );
    const result = await tool.execute!({ command: "ls" }, opts);
    expect(result).toEqual({ error: expect.stringMatching(/home\/user/) });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("buildSandboxBashTool — lifetime wording", () => {
  it("defaults to the run lifetime: destroyed after this session", () => {
    const tool = buildSandboxBashTool({ sandboxId: "sbx" });
    // Unchanged for evals and swarms, where the box really is per-run.
    expect(tool.description).toMatch(/destroyed afterwards/);
    expect(tool.description).not.toMatch(/PERSISTS/);
  });

  it("tells a scenario model the box survives between turns", () => {
    // Not cosmetic: a model that believes its files vanish will re-create
    // scratch files each turn and never build on earlier work — defeating the
    // point of a conversation-scoped shell.
    const tool = buildSandboxBashTool({
      sandboxId: "sbx",
      lifetime: "conversation",
    });
    expect(tool.description).toMatch(/PERSISTS across the turns/);
    expect(tool.description).toMatch(/reclaimed after a long idle period/);
    expect(tool.description).not.toMatch(/destroyed afterwards/);
  });
});

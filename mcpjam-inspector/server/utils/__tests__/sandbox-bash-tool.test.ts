import { describe, it, expect, vi } from "vitest";
import {
  buildEvalBashTool,
  buildSandboxBashTool,
  EVAL_BASH_TOOL_NAME,
} from "../built-in-tools/sandbox-bash";
import type { BashRunner } from "../computers/run-command";

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
    await tool.execute!({ command: "echo x", timeoutSeconds: 600 }, opts);
    expect(seenTimeout).toBe(600_000);
  });
});

describe("buildSandboxBashTool — workdir", () => {
  function captureCommand() {
    let seen = "";
    const runner: BashRunner = vi.fn(async (a) => {
      seen = a.command;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    return { runner, seen: () => seen };
  }

  it("runs commands IN the configured workdir", async () => {
    // On the personal path `workdir` is where commands execute, not merely a
    // confinement boundary — dropping it here would silently relocate every
    // command a host configured.
    const { runner, seen } = captureCommand();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "/srv/app" },
      runner
    );
    await tool.execute!({ command: "pwd" }, opts);
    expect(seen()).toBe("mkdir -p '/srv/app' && cd '/srv/app' && pwd");
  });

  it("quotes a workdir containing a space or an apostrophe", async () => {
    const { runner, seen } = captureCommand();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "/srv/my app's dir" },
      runner
    );
    await tool.execute!({ command: "pwd" }, opts);
    expect(seen()).toContain(`cd '/srv/my app'\\''s dir'`);
  });

  it("passes the command through verbatim when no workdir is bound", async () => {
    // Keeps the eval iteration path byte-identical to before the rename.
    const { runner, seen } = captureCommand();
    const tool = buildSandboxBashTool({ sandboxId: "sbx" }, runner);
    await tool.execute!({ command: "echo hi" }, opts);
    expect(seen()).toBe("echo hi");
  });

  it("treats a blank workdir as absent", async () => {
    const { runner, seen } = captureCommand();
    const tool = buildSandboxBashTool(
      { sandboxId: "sbx", workdir: "  " },
      runner
    );
    await tool.execute!({ command: "echo hi" }, opts);
    expect(seen()).toBe("echo hi");
  });
});

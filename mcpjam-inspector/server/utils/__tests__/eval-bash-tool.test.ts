import { describe, it, expect, vi } from "vitest";
import {
  buildEvalBashTool,
  EVAL_BASH_TOOL_NAME,
} from "../built-in-tools/eval-bash";
import type { BashRunner } from "../computers/run-command";

// The eval bash tool binds directly to a KNOWN sandbox id (no control-plane
// reserve/sandbox-info) — exercise it with an injectable runner.

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
      expect.objectContaining({ sandboxId: "sbx_eval_1", command: "echo hello" })
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
    expect(result).toEqual({ error: "Command failed to run in the eval sandbox." });
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

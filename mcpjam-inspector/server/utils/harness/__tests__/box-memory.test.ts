import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import {
  BOX_MEMORY_COMMAND,
  assertBoxMemoryForHarness,
  parseBoxMemory,
  stderrWithStopReason,
} from "../box-memory.js";
import {
  HarnessInfraSetupError,
  harnessFailureEvidenceOf,
} from "../harness-provider-error.js";

// What `BOX_MEMORY_COMMAND` printed on live E2B boxes: `base` (512 MiB) after
// pnpm was OOM-killed, and a 1 GiB computer template box.
const BASE_BOX = "MemTotal:         484444 kB\noom_kill 1\n";
const ONE_GIB_BOX = "MemTotal:         999424 kB\noom_kill 0\n";

const answering = (stdout: string) =>
  vi.fn(async (_command: string, _options: { timeoutMs: number }) => ({
    stdout,
  }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseBoxMemory", () => {
  it("reads the box's size in MiB and its OOM-kill count", () => {
    expect(parseBoxMemory(BASE_BOX)).toEqual({ totalMiB: 473, oomKills: 1 });
  });

  it("leaves out what the box did not print", () => {
    expect(parseBoxMemory("MemTotal: 999424 kB\n")).toEqual({ totalMiB: 976 });
    expect(parseBoxMemory("")).toEqual({});
  });
});

describe("assertBoxMemoryForHarness", () => {
  it("refuses OpenCode on a base box with a typed setup error that says what to do", async () => {
    const run = answering(BASE_BOX);
    const failure = await assertBoxMemoryForHarness(run, "opencode").catch(
      (error: unknown) => error,
    );
    expect(run).toHaveBeenCalledWith(BOX_MEMORY_COMMAND, { timeoutMs: 5000 });
    expect(failure).toBeInstanceOf(HarnessInfraSetupError);
    expect(harnessFailureEvidenceOf(failure)).toEqual({
      source: "sandbox_setup",
      code: "box_memory_too_small",
    });
    expect((failure as Error).message).toMatch(
      /473 MiB.*at least 1 GiB.*MCPJam computer template/s,
    );
  });

  it("lets OpenCode run on a 1 GiB box", async () => {
    await expect(
      assertBoxMemoryForHarness(answering(ONE_GIB_BOX), "opencode"),
    ).resolves.toBeUndefined();
  });

  it("asks nothing of the box for a harness without a floor", async () => {
    const run = answering(BASE_BOX);
    await assertBoxMemoryForHarness(run, "claude-code");
    await assertBoxMemoryForHarness(run, undefined);
    expect(run).not.toHaveBeenCalled();
  });

  it("lets the harness through when the box cannot be read", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error("sandbox unreachable");
    });
    await expect(
      assertBoxMemoryForHarness(run, "opencode"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[harness][box-memory] could not read the box's memory",
      { reason: "Error" },
    );
  });

  it("stops when the caller aborts", async () => {
    const stop = new AbortController();
    const run = vi.fn(async () => {
      stop.abort(new Error("turn cancelled"));
      throw new Error("aborted");
    });
    await expect(
      assertBoxMemoryForHarness(run, "opencode", stop.signal),
    ).rejects.toThrow("turn cancelled");
  });
});

describe("stderrWithStopReason", () => {
  it("leaves a command that exited on its own alone", async () => {
    const run = answering(BASE_BOX);
    await expect(
      stderrWithStopReason(
        { exitCode: 1, error: "exit status 1", stderr: "boom" },
        run,
      ),
    ).resolves.toBe("boom");
    expect(run).not.toHaveBeenCalled();
  });

  it("names a likely out-of-memory kill for a SIGKILL on a box whose kernel killed for memory", async () => {
    // The `pnpm install` E2B reported as `exit -1`: its stderr was empty.
    await expect(
      stderrWithStopReason(
        { exitCode: -1, error: "signal: killed", stderr: "" },
        answering(BASE_BOX),
      ),
    ).resolves.toBe(
      "The sandbox killed this command (signal: killed). The box's kernel " +
        "has stopped 1 process for lack of memory since it booted, so this " +
        "command likely ran out of memory. The box has 473 MiB. Run this " +
        "client on a computer with more memory, such as one built from the " +
        "MCPJam computer template.",
    );
  });

  it("never blames memory for a signal the OOM killer does not send, even after an earlier OOM kill", async () => {
    // `oom_kill` is box-wide and only grows: an old kill says nothing about
    // a command SIGTERM stopped.
    const run = answering(BASE_BOX);
    await expect(
      stderrWithStopReason(
        {
          exitCode: -1,
          error: "signal: terminated",
          stderr: "partial output\n",
        },
        run,
      ),
    ).resolves.toBe(
      "partial output\nThe sandbox stopped this command before it finished (signal: terminated).",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a SIGKILL alone on a box whose kernel never killed for memory", async () => {
    await expect(
      stderrWithStopReason(
        { exitCode: -1, error: "signal: killed", stderr: "" },
        answering(ONE_GIB_BOX),
      ),
    ).resolves.toBe(
      "The sandbox stopped this command before it finished (signal: killed).",
    );
  });
});

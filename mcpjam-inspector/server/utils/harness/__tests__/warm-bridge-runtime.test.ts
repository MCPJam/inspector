import type {
  HarnessV1,
  HarnessV1Session,
  HarnessV1StartOptions,
} from "@ai-sdk/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withWarmBridgeRuntime,
  WARM_ATTACH_TIMEOUT_MS,
  WARM_RETENTION_TIMEOUT_MS,
} from "../warm-bridge-runtime.js";

/** The box's idle window, as the backend sends it. */
const WINDOW_MS = 5 * 60_000;

const unused = async (): Promise<never> => {
  throw new Error("Unexpected test operation");
};
const state = {
  type: "resume-session",
  specificationVersion: "harness-v1",
  harnessId: "codex",
  data: {
    bridge: { port: 8080, token: "fresh-channel-token" },
    threadId: "thread",
  },
} as const;

function fixture() {
  const detach = vi.fn(async () => state);
  const session: HarnessV1Session = {
    sessionId: "session",
    isResume: true,
    doPromptTurn: unused,
    doContinueTurn: unused,
    doCompact: unused,
    doSuspendTurn: unused,
    doDetach: detach,
    doStop: detach,
    doDestroy: vi.fn(async () => undefined),
  };
  const start = vi.fn(async (_options: HarnessV1StartOptions) => session);
  const factory = vi.fn(
    (_timeout?: number, _home?: string): HarnessV1 => ({
      specificationVersion: "harness-v1",
      harnessId: "codex",
      doStart: start,
    }),
  );
  const run = vi.fn(async (_args: { command: string }) => ({ exitCode: 0, stdout: JSON.stringify({ ready: true, home: "/home/user" }), stderr: "" }));
  const spawn = vi.fn(unused);
  const options: HarnessV1StartOptions = {
    sessionId: "session",
    sessionWorkDir: "/home/user/work",
    resumeFrom: state,
    sandboxSession: {
      description: "test",
      defaultWorkingDirectory: "/home/user",
      readFile: unused,
      readBinaryFile: unused,
      readTextFile: unused,
      writeFile: unused,
      writeBinaryFile: unused,
      writeTextFile: unused,
      spawn,
      run,
    },
  };
  return { session, detach, factory, start, options, run, spawn };
}

afterEach(() => vi.useRealTimers());

describe("warm runtime lifecycle", () => {
  it.each([
    { sessionId: "session", segment: "session" },
    { sessionId: "../shared/session", segment: "..%2Fshared%2Fsession" },
    { sessionId: "..", segment: "%2E%2E" },
  ])("uses private HOME state for a custom workspace ($sessionId)", async ({ sessionId, segment }) => {
    const f = fixture();
    const workspace = "/workspace/custom-project";
    const options = {
      ...f.options,
      sessionId,
      sandboxSession: { ...f.options.sandboxSession, defaultWorkingDirectory: workspace },
    };
    const session = await withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart(options);
    await session.doDetach();
    expect(f.run).toHaveBeenCalledTimes(2);
    for (const [{ command }] of f.run.mock.calls) {
      expect(command).toContain(`.ai-sdk-harness/.agent-runs/${segment}/bridge`);
      expect(command).not.toContain(workspace);
      // The window rides the command line; nothing in the box decides it.
      expect(command).toMatch(new RegExp(`'${WINDOW_MS}'$`));
    }
  });

  it("attaches without dispatching a prompt and refreshes retention on detach", async () => {
    const f = fixture();
    const runtime = withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS);
    const session = await runtime.doStart(f.options);
    expect(f.factory).toHaveBeenLastCalledWith(WARM_ATTACH_TIMEOUT_MS, "/home/user");
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0].resumeFrom).toBe(state);
    await session.doDetach();
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]).toBeDefined();
  });

  it.each([undefined, "", "relative/path", "/home/\0bad"])(
    "does not forward an invalid sandbox HOME: %s", async (home) => {
      const f = fixture();
      f.run.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ ready: true, home }), stderr: "" });
      await withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart(f.options);
      expect(f.factory).toHaveBeenLastCalledWith(WARM_ATTACH_TIMEOUT_MS, undefined);
    },
  );

  it("does not accept HOME from saved session state", async () => {
    const f = fixture();
    f.options.resumeFrom = { ...state, data: { ...state.data, home: "/untrusted" } };
    await withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart(f.options);
    expect(f.factory).toHaveBeenLastCalledWith(WARM_ATTACH_TIMEOUT_MS, "/home/user");
  });

  it("uses disk continuity when the identity or configuration probe refuses reuse", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });
    await withWarmBridgeRuntime(f.factory, "changed", WINDOW_MS).doStart(f.options);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0].resumeFrom?.data).toEqual({
      threadId: "thread",
    });
  });

  it("bounds a hanging probe and detaches a late connection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.run.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart(
      f.options,
    );
    await vi.advanceTimersByTimeAsync(WARM_ATTACH_TIMEOUT_MS);
    await pending;
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0].resumeFrom?.data).toEqual({
      threadId: "thread",
    });
  });

  it("forbids the adapter's implicit spawn fallback during an attach attempt", async () => {
    const f = fixture();
    f.start.mockImplementationOnce(async (options) => {
      await options.sandboxSession.spawn({ command: "must-not-run" });
      return f.session;
    });
    await withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart(f.options);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.start.mock.calls[1][0].resumeFrom?.data).toEqual({
      threadId: "thread",
    });
  });

  it("never cold-starts after the caller cancels", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const abort = new AbortController();
    f.run.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart({
      ...f.options,
      abortSignal: abort.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    abort.abort();
    await vi.advanceTimersByTimeAsync(WARM_ATTACH_TIMEOUT_MS);
    await rejected;
    expect(f.start).not.toHaveBeenCalled();
  });

  it("preserves approval continuation and retains its completed process", async () => {
    const f = fixture();
    const continuing = {
      ...f.options,
      resumeFrom: undefined,
      continueFrom: { ...state, type: "continue-turn" as const },
    };
    const result = await withWarmBridgeRuntime(
      f.factory,
      "configuration",
      WINDOW_MS,
    ).doStart(continuing);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledWith(continuing);
    expect(await result.doDetach()).toEqual(state);
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("detaches an attach that succeeds after cancellation without cold-starting", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const abort = new AbortController();
    let resolveAttach!: (session: HarnessV1Session) => void;
    f.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve;
        }),
    );
    const pending = withWarmBridgeRuntime(f.factory, "configuration", WINDOW_MS).doStart({
      ...f.options,
      abortSignal: abort.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(WARM_ATTACH_TIMEOUT_MS);
    await rejected;
    resolveAttach(f.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("returns disk continuity when the optional retention write stalls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const session = await withWarmBridgeRuntime(
      f.factory,
      "configuration",
      WINDOW_MS,
    ).doStart(f.options);
    f.run.mockImplementationOnce(() => new Promise(() => undefined));
    const detached = session.doDetach();
    await vi.advanceTimersByTimeAsync(WARM_RETENTION_TIMEOUT_MS);
    expect(await detached).toEqual(state);
  });
});

it.each(["claude-code", "codex"] as const)(
  "keeps the pilot launch isolated from the baked %s entrypoint",
  async (id) => {
    const { createHostedClaudeCodeHarness } =
      await import("../claude-code-typed-errors.js");
    const { createCodexAppServer } =
      await import("../codex-appserver/codex-appserver-harness.js");
    const { withWarmBridgeBootstrap } = await import("../warm-bridge-files.js");
    const f = fixture();
    const ordinary =
      id === "codex" ? createCodexAppServer() : createHostedClaudeCodeHarness();
    const recipe = await ordinary.getBootstrap?.();
    if (!recipe) throw Error("Missing installed recipe");
    const spawn = vi.fn(unused);
    const dir = "/home/user/.ai-sdk-harness/" + recipe.bootstrapDir;
    const command = "node '" + dir + "/bridge.mjs' --workdir '/home/user/work'";
    const runtime = withWarmBridgeBootstrap({
      ...ordinary,
      doStart: async (options: HarnessV1StartOptions) => {
        await options.sandboxSession.spawn({ command });
        return f.session;
      },
    });
    const pilot = await runtime.getBootstrap?.();
    expect(
      pilot?.files.some(
        (file) => file.path === recipe.bootstrapDir + "/bridge.mjs",
      ),
    ).toBe(false);
    expect(
      pilot?.files.find((file) => file.path.endsWith("/warm-bridge.mjs"))
        ?.content,
    ).toContain("Another connection owns this message.");
    const sandboxSession = {
      ...f.options.sandboxSession,
      defaultWorkingDirectory: "/home/user",
      spawn,
      run: async ({ command }: { command: string }) =>
        command.includes("$HOME")
          ? { exitCode: 0, stdout: "/home/user", stderr: "" }
          : { exitCode: 0, stdout: "ready", stderr: "" },
    };
    await expect(
      runtime.doStart({ ...f.options, sandboxSession }),
    ).rejects.toThrow("Unexpected test operation");
    expect(spawn).toHaveBeenCalledWith({
      command: command.replace("/bridge.mjs'", "/warm-bridge.mjs'"),
    });
    expect(
      (await ordinary.getBootstrap?.())?.files.some((file) =>
        file.path.endsWith("/warm-bridge.mjs"),
      ),
    ).toBe(false);
  },
);

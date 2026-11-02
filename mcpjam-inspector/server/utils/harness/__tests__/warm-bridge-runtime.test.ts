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
    (_timeout?: number): HarnessV1 => ({
      specificationVersion: "harness-v1",
      harnessId: "codex",
      doStart: start,
    }),
  );
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "ready", stderr: "" }));
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
  it("attaches without dispatching a prompt and refreshes retention on detach", async () => {
    const f = fixture();
    const runtime = withWarmBridgeRuntime(f.factory, "configuration");
    const session = await runtime.doStart(f.options);
    expect(f.factory).toHaveBeenLastCalledWith(WARM_ATTACH_TIMEOUT_MS);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0].resumeFrom).toBe(state);
    await session.doDetach();
    expect(f.detach).toHaveBeenCalledTimes(1);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]).toBeDefined();
  });

  it("uses disk continuity when the identity or configuration probe refuses reuse", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });
    await withWarmBridgeRuntime(f.factory, "changed").doStart(f.options);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0].resumeFrom?.data).toEqual({
      threadId: "thread",
    });
  });

  it("bounds a hanging probe and detaches a late connection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.run.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = withWarmBridgeRuntime(f.factory, "configuration").doStart(
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
    await withWarmBridgeRuntime(f.factory, "configuration").doStart(f.options);
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
    const pending = withWarmBridgeRuntime(f.factory, "configuration").doStart({
      ...f.options,
      abortSignal: abort.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    abort.abort();
    await vi.advanceTimersByTimeAsync(WARM_ATTACH_TIMEOUT_MS);
    await rejected;
    expect(f.start).not.toHaveBeenCalled();
  });

  it("leaves paused approvals on the existing continuation path", async () => {
    const f = fixture();
    const continuing = {
      ...f.options,
      resumeFrom: undefined,
      continueFrom: { ...state, type: "continue-turn" as const },
    };
    const result = await withWarmBridgeRuntime(
      f.factory,
      "configuration",
    ).doStart(continuing);
    expect(result).toBe(f.session);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledWith(continuing);
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
    const pending = withWarmBridgeRuntime(f.factory, "configuration").doStart({
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
    ).doStart(f.options);
    f.run.mockImplementationOnce(() => new Promise(() => undefined));
    const detached = session.doDetach();
    await vi.advanceTimersByTimeAsync(WARM_RETENTION_TIMEOUT_MS);
    expect(await detached).toEqual(state);
  });
});

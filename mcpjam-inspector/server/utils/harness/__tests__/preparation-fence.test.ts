import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparationFence, StaleClaimError } from "../preparation-fence";

const BOUND_MS = 150_000;
const MARGIN_MS = 30_000;
const TTL_MS = 300_000;
const RESULT = { exitCode: 0, stdout: "", stderr: "" };

function innerSession() {
  return {
    description: "box",
    readFile: vi.fn(async () => null),
    readBinaryFile: vi.fn(async () => null),
    readTextFile: vi.fn(async () => "marker"),
    writeFile: vi.fn(async () => undefined),
    writeBinaryFile: vi.fn(async () => undefined),
    writeTextFile: vi.fn(async () => undefined),
    spawn: vi.fn(),
    run: vi.fn(async () => RESULT),
  } satisfies Experimental_SandboxSession;
}

/** A fence whose claim the backend answered with `TTL_MS` left, just now. */
function fence(signal = new AbortController().signal) {
  const guard = new PreparationFence({
    commandBoundMs: BOUND_MS,
    marginMs: MARGIN_MS,
    signal,
  });
  guard.confirm(performance.now(), TTL_MS);
  return guard;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the fence around a preparation's work in the box", () => {
  it("runs every command under timeout -s KILL at its bound", async () => {
    const inner = innerSession();
    await fence()
      .session(inner)
      .run({ command: "echo 'it''s' && pnpm install", workingDirectory: "/w" });
    expect(inner.run).toHaveBeenCalledWith({
      command: `timeout -s KILL 150 bash -c 'echo '\\''it'\\'''\\''s'\\'' && pnpm install'`,
      workingDirectory: "/w",
    });
  });

  it("starts nothing that could outlast the claim it can prove", async () => {
    const inner = innerSession();
    const session = fence().session(inner);
    // A command started now ends by now + bound + margin: inside the TTL
    // until 120 s in, on the monotonic clock.
    vi.advanceTimersByTime(TTL_MS - BOUND_MS - MARGIN_MS - 1);
    await expect(session.run({ command: "true" })).resolves.toBe(RESULT);
    vi.advanceTimersByTime(1);
    await expect(session.run({ command: "true" })).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    await expect(
      session.writeTextFile({ path: "/x", content: "" }),
    ).rejects.toBeInstanceOf(StaleClaimError);
    // Reads start nothing, so they pass.
    await expect(session.readTextFile({ path: "/x" })).resolves.toBe("marker");
    expect(inner.run).toHaveBeenCalledTimes(1);
    expect(inner.writeTextFile).not.toHaveBeenCalled();
  });

  it("proves nothing without an answer's TTL", async () => {
    const guard = new PreparationFence({
      commandBoundMs: BOUND_MS,
      marginMs: MARGIN_MS,
      signal: new AbortController().signal,
    });
    guard.confirm(performance.now(), undefined);
    await expect(
      guard.session(innerSession()).run({ command: "true" }),
    ).rejects.toBeInstanceOf(StaleClaimError);
  });

  it("counts a renewal's TTL from when it was sent, never moving back", async () => {
    const guard = fence();
    const session = guard.session(innerSession());
    vi.advanceTimersByTime(60_000);
    const renewalSentAt = performance.now();
    // Answered ten seconds later; an older answer arriving late changes nothing.
    vi.advanceTimersByTime(10_000);
    guard.confirm(renewalSentAt, TTL_MS);
    guard.confirm(renewalSentAt - 60_000, TTL_MS);
    const lastStart = renewalSentAt + TTL_MS - BOUND_MS - MARGIN_MS;
    vi.advanceTimersByTime(lastStart - 1 - performance.now());
    await expect(session.run({ command: "true" })).resolves.toBe(RESULT);
    vi.advanceTimersByTime(1);
    await expect(session.run({ command: "true" })).rejects.toBeInstanceOf(
      StaleClaimError,
    );
  });

  it("starts nothing once aborted", async () => {
    const stop = new AbortController();
    const session = fence(stop.signal).session(innerSession());
    stop.abort(new Error("stopped"));
    await expect(session.run({ command: "true" })).rejects.toThrow("stopped");
  });

  it("refuses to spawn: a spawned process runs with no timeout", async () => {
    const inner = innerSession();
    await expect(
      fence().session(inner).spawn({ command: "x" }),
    ).rejects.toThrow();
    expect(inner.spawn).not.toHaveBeenCalled();
  });

  it("hands the claim back at once when every call returned", async () => {
    const guard = fence();
    const session = guard.session(innerSession());
    await session.run({ command: "true" });
    await session.writeTextFile({ path: "/x", content: "" });
    expect(guard.releasableAt()).toBeLessThanOrEqual(performance.now());
  });

  it("after a command whose call threw, only once its bound has passed", async () => {
    const guard = fence();
    const inner = innerSession();
    const startedAt = performance.now();
    inner.run.mockRejectedValueOnce(new Error("connection reset"));
    await expect(guard.session(inner).run({ command: "x" })).rejects.toThrow();
    expect(guard.releasableAt()).toBe(startedAt + BOUND_MS + MARGIN_MS);
  });

  it("never, while a write that threw may still land", async () => {
    const guard = fence();
    const inner = innerSession();
    inner.writeTextFile.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      guard.session(inner).writeTextFile({ path: "/x", content: "" }),
    ).rejects.toThrow();
    expect(guard.releasableAt()).toBeUndefined();
  });

  it("probes without the bound, still fenced", async () => {
    const inner = innerSession();
    await fence().probe(inner, "timeout --version");
    expect(inner.run).toHaveBeenCalledWith({ command: "timeout --version" });
  });
});

import type { Experimental_SandboxSession } from "@ai-sdk/provider-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparationFence, StaleClaimError } from "../preparation-fence";

const FRESH_MS = 75_000;
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

function fence(signal = new AbortController().signal) {
  return new PreparationFence({
    sentAt: Date.now(),
    freshMs: FRESH_MS,
    signal,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the fence around a preparation's commands", () => {
  it("starts commands and writes while the claim is fresh, and none after", async () => {
    const inner = innerSession();
    const session = fence().session(inner);
    await expect(session.run({ command: "true" })).resolves.toBe(RESULT);
    vi.setSystemTime(Date.now() + FRESH_MS + 1);
    await expect(session.run({ command: "true" })).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    await expect(
      session.writeTextFile({ path: "/x", content: "" }),
    ).rejects.toBeInstanceOf(StaleClaimError);
    await expect(session.spawn({ command: "x" })).rejects.toBeInstanceOf(
      StaleClaimError,
    );
    // Reads start nothing, so they pass.
    await expect(session.readTextFile({ path: "/x" })).resolves.toBe("marker");
    expect(inner.run).toHaveBeenCalledTimes(1);
    expect(inner.writeTextFile).not.toHaveBeenCalled();
    expect(inner.spawn).not.toHaveBeenCalled();
  });

  it("a confirmed renewal keeps it fresh from when that renewal was sent", async () => {
    const guard = fence();
    const session = guard.session(innerSession());
    const renewalSentAt = Date.now() + 60_000;
    vi.setSystemTime(renewalSentAt + 1_000);
    guard.confirm(renewalSentAt);
    vi.setSystemTime(renewalSentAt + FRESH_MS);
    await expect(session.run({ command: "true" })).resolves.toBe(RESULT);
    // An older confirmation arriving late never moves it back.
    guard.confirm(renewalSentAt - 60_000);
    await expect(session.run({ command: "true" })).resolves.toBe(RESULT);
  });

  it("starts nothing once aborted", async () => {
    const stop = new AbortController();
    const session = fence(stop.signal).session(innerSession());
    stop.abort(new Error("stopped"));
    await expect(session.run({ command: "true" })).rejects.toThrow("stopped");
  });

  it("is idle only when every command's call returned", async () => {
    const guard = fence();
    const inner = innerSession();
    const session = guard.session(inner);
    await session.run({ command: "true" });
    expect(guard.idle).toBe(true);

    // A call that threw may have left its command running.
    inner.run.mockRejectedValueOnce(new Error("connection reset"));
    await expect(session.run({ command: "true" })).rejects.toThrow();
    expect(guard.idle).toBe(false);
  });

  it("never counts a spawned process as ended", async () => {
    const guard = fence();
    const inner = innerSession();
    inner.spawn.mockResolvedValue({});
    await guard.session(inner).spawn({ command: "x" });
    expect(guard.idle).toBe(false);
  });
});

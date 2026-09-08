/**
 * Video evidence for an unattended run, and the one rule it must never break:
 * evidence never costs a run its box.
 *
 * Every failure mode here — a daemon that has gone away, a read that hangs, an
 * SDK that throws — has to answer `null` inside the deadline so the caller
 * releases exactly as it would have. The tests that matter most are the ugly
 * ones, because the happy path is the one anybody would have written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHostedRecordings,
  collectHostedRecordingBeforeRelease,
  forgetHostedRecording,
  recordingIdFor,
  startHostedRecording,
} from "../hosted-recording";
import type { SandboxHostedBrowserSessionHandle } from "../browser-session";

const RECORDING = {
  path: "/rec/sess-1.mp4",
  bytes: 4_096,
  durationMs: 9_000,
  distinctFrames: 42,
  truncated: false,
};

function fakeHandle(
  over: {
    features?: readonly string[];
    statusKind?: "ok" | "unhealthy";
    record?: unknown;
    omitRecord?: boolean;
  } = {},
) {
  const calls: Array<{ action: string; id?: string; fps?: number }> = [];
  const record = vi.fn(async (args: { action: string; id?: string; fps?: number }) => {
    calls.push(args);
    if (over.record) return over.record as never;
    return args.action === "stop"
      ? { ok: true, recording: RECORDING }
      : { ok: true };
  });
  const handle = {
    engine: "hosted",
    target: "sandbox",
    sessionId: "sess-1",
    sandboxRowId: "row-1",
    sandboxId: "sbx-1",
    bootId: "boot-1",
    contextMode: "ephemeral",
    reused: false,
    client: {
      status: async () => ({
        kind: over.statusKind ?? "ok",
        bootId: "boot-1",
        features: over.features ?? ["record"],
      }),
      sendCommand: async () => ({ kind: "ok" }) as never,
      ...(over.omitRecord ? {} : { record }),
    },
  } as unknown as SandboxHostedBrowserSessionHandle;
  return { handle, record, calls };
}

function fakeSandbox(
  over: { read?: () => Promise<Uint8Array>; omitRead?: boolean } = {},
) {
  const disconnect = vi.fn(async () => {});
  const readBinaryFile = vi.fn(
    over.read ?? (async () => new Uint8Array([1, 2, 3, 4])),
  );
  return {
    disconnect,
    readBinaryFile,
    sandbox: {
      writeBundle: async () => {},
      browserd: {} as never,
      killBrowserd: async () => {},
      ensureStream: async () => ({ streamUrl: "", streamPassword: "" }),
      disconnect,
      ...(over.omitRead ? {} : { readBinaryFile }),
    } as never,
  };
}

describe("hosted recording — starting", () => {
  beforeEach(() => __resetHostedRecordings());
  afterEach(() => {
    delete process.env.MCPJAM_HOSTED_BROWSER_RECORDING;
    __resetHostedRecordings();
  });

  it("starts at 15fps with an id derived from the session", async () => {
    const { handle, calls } = fakeHandle();
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    expect(calls).toEqual([{ action: "start", id: "sess-1", fps: 15 }]);
  });

  it("is idempotent, and the second call costs no network at all", async () => {
    // `ensureLiveBrowserSession` runs once per turn on the lazy browser-tool
    // path, so an iteration with ten browser turns would otherwise send ten
    // starts and read nine `record_active` refusals — noise indistinguishable
    // from a real conflict.
    const { handle, record } = fakeHandle();
    const status = vi.spyOn(handle.client, "status");
    const deps = { connect: async () => fakeSandbox().sandbox };

    await startHostedRecording(handle, deps);
    await startHostedRecording(handle, deps);

    expect(record).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("does not call a route the daemon never advertised", async () => {
    // The no-forced-relaunch rule: an older daemon is a normal thing to meet
    // mid-rollout, and asking it would turn a missing video into a 404 in the
    // logs of every run.
    const { handle, record } = fakeHandle({ features: ["h264"] });
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    expect(record).not.toHaveBeenCalled();
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("does nothing when the deployment turned recording off", async () => {
    process.env.MCPJAM_HOSTED_BROWSER_RECORDING = "0";
    const { handle, record } = fakeHandle();
    const status = vi.spyOn(handle.client, "status");

    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });

    expect(record).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("reads the switch at CALL time, so a flip needs no redeploy", async () => {
    process.env.MCPJAM_HOSTED_BROWSER_RECORDING = "0";
    const off = fakeHandle();
    await startHostedRecording(off.handle, {
      connect: async () => fakeSandbox().sandbox,
    });
    expect(off.record).not.toHaveBeenCalled();

    delete process.env.MCPJAM_HOSTED_BROWSER_RECORDING;
    const on = fakeHandle();
    await startHostedRecording(on.handle, {
      connect: async () => fakeSandbox().sandbox,
    });
    expect(on.record).toHaveBeenCalled();
  });

  it("registers a 409 anyway — the file exists and only a stop ends it", async () => {
    const { handle } = fakeHandle({
      record: { ok: false, status: 409, error: "record_active" },
    });
    const sandbox = fakeSandbox();
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    // Not registering it would leave a daemon recording for the rest of the
    // box's life, into a file nothing ever reads.
    handle.client.record = (async () => ({
      ok: true,
      recording: RECORDING,
    })) as never;
    expect(await collectHostedRecordingBeforeRelease("row-1")).not.toBeNull();
  });

  it("does not register a start the daemon refused for any other reason", async () => {
    const { handle } = fakeHandle({
      record: { ok: false, status: 503, error: "record_unavailable" },
    });
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("never throws when the daemon is unreachable", async () => {
    // A run with no video is strictly better than a run that does not happen.
    const { handle } = fakeHandle();
    handle.client.status = (async () => {
      throw new Error("ECONNREFUSED");
    }) as never;

    await expect(
      startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox }),
    ).resolves.toBeUndefined();
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("reduces a session id to something the daemon's route accepts", () => {
    // An id the route refuses is a 400 that reads, in a log, exactly like a
    // daemon that cannot record — and the two want different fixes.
    expect(recordingIdFor("k17abc_DEF-9")).toBe("k17abc_DEF-9");
    expect(recordingIdFor("a/../b c")).toBe("a----b-c");
    expect(recordingIdFor("x".repeat(200))).toHaveLength(64);
    expect(recordingIdFor("")).toBe("recording");
    expect(recordingIdFor("///")).toBe("---");
  });
});

describe("hosted recording — collecting before release", () => {
  beforeEach(() => __resetHostedRecordings());
  afterEach(() => __resetHostedRecordings());

  it("stops, reads the file, and disconnects", async () => {
    const { handle, calls } = fakeHandle();
    const sandbox = fakeSandbox();
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    const collected = await collectHostedRecordingBeforeRelease("row-1");

    expect(calls[1]).toEqual({ action: "stop" });
    expect(sandbox.readBinaryFile).toHaveBeenCalledWith("/rec/sess-1.mp4");
    expect(sandbox.disconnect).toHaveBeenCalledTimes(1);
    expect(collected).toMatchObject({
      mime: "video/mp4",
      durationMs: 9_000,
      distinctFrames: 42,
      fps: 15,
      truncated: false,
    });
    expect(collected!.bytes.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(collected!.startedAtMs).toBeGreaterThan(0);
  });

  it("answers null with NO network for a row it never recorded", async () => {
    // The common case: a run that never touched a browser tool. It must cost
    // the release path nothing at all.
    const connect = vi.fn(async () => fakeSandbox().sandbox);
    expect(await collectHostedRecordingBeforeRelease("row-unknown")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it("collects at most once, so a second exit is a cheap no-op", async () => {
    const { handle, record } = fakeHandle();
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });

    expect(await collectHostedRecordingBeforeRelease("row-1")).not.toBeNull();
    record.mockClear();
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("drops a zero-byte take rather than uploading an unplayable file", async () => {
    // An empty player on the trace page reads as a bug in the product; a run
    // with no video reads as a run with no video.
    const { handle } = fakeHandle({
      record: { ok: true, recording: { ...RECORDING, bytes: 0 } },
    });
    const sandbox = fakeSandbox();
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
  });

  it("carries `truncated` through instead of hiding it", async () => {
    const { handle } = fakeHandle({
      record: { ok: true, recording: { ...RECORDING, truncated: true } },
    });
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    expect(await collectHostedRecordingBeforeRelease("row-1")).toMatchObject({
      truncated: true,
    });
  });

  it("answers null when the stop fails, and forgets the take", async () => {
    const { handle } = fakeHandle();
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    handle.client.record = (async () => ({
      ok: false,
      status: 503,
      error: "record_unavailable",
    })) as never;

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("answers null when the read throws, and still disconnects", async () => {
    const { handle } = fakeHandle();
    const sandbox = fakeSandbox({
      read: async () => {
        throw new Error("ENOENT");
      },
    });
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    // The CONNECTION, not the box — leaking it would outlive the run.
    expect(sandbox.disconnect).toHaveBeenCalledTimes(1);
  });

  it("answers null against an adapter that cannot read binary files", async () => {
    const { handle } = fakeHandle();
    const sandbox = fakeSandbox({ omitRead: true });
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(sandbox.disconnect).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline rather than holding a paid box open", async () => {
    // THE RULE. A read that hangs hangs — the E2B files API takes no signal on
    // this path — so what has to be bounded is the CALLER's waiting. The
    // orphaned read finishes into a void and the box is released on schedule.
    vi.useFakeTimers();
    try {
      const { handle } = fakeHandle();
      const sandbox = fakeSandbox({ read: () => new Promise<Uint8Array>(() => {}) });
      await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

      const collecting = collectHostedRecordingBeforeRelease("row-1", {
        timeoutMs: 45_000,
      });
      await vi.advanceTimersByTimeAsync(45_000);

      expect(await collecting).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a take without stopping it, for a box that has already gone", async () => {
    const { handle, record } = fakeHandle();
    await startHostedRecording(handle, { connect: async () => fakeSandbox().sandbox });
    record.mockClear();

    forgetHostedRecording("row-1");

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});

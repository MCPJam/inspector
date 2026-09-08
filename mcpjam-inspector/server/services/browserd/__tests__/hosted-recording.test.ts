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
    /** What a `start` answers. */
    record?: unknown;
    /**
     * What a `stop` answers, when it differs from the start's reply.
     *
     * Split from `record` because the module captures `client.record` at START
     * time — a take belongs to the client that began it, so reassigning the
     * handle's method afterwards (which an earlier version of these tests did)
     * no longer reaches the stop. Saying it here says what the daemon
     * answered, rather than depending on when the reference was read.
     */
    stopResult?: unknown;
    omitRecord?: boolean;
    bootId?: string;
    /** What `GET /v1/record` says is recording right now. */
    recordState?: unknown;
  } = {},
) {
  const calls: Array<{ action: string; id?: string; fps?: number }> = [];
  const record = vi.fn(async (args: { action: string; id?: string; fps?: number }) => {
    calls.push(args);
    if (args.action === "stop") {
      if (over.stopResult) return over.stopResult as never;
      if (over.record) return over.record as never;
      return { ok: true, recording: RECORDING } as never;
    }
    if (over.record) return over.record as never;
    return { ok: true } as never;
  });
  const handle = {
    engine: "hosted",
    target: "sandbox",
    sessionId: "sess-1",
    sandboxRowId: "row-1",
    sandboxId: "sbx-1",
    bootId: over.bootId ?? "boot-1",
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
      recordStatus: async () => over.recordState ?? { active: false },
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

  it("registers a 409 that names OUR take — a racing start from this run", async () => {
    const { handle } = fakeHandle({
      record: { ok: false, status: 409, error: "record_active" },
      recordState: { active: true, id: "sess-1", fps: 15 },
      stopResult: { ok: true, recording: RECORDING },
    });
    const sandbox = fakeSandbox();
    await startHostedRecording(handle, { connect: async () => sandbox.sandbox });

    // Not registering it would leave a daemon recording for the rest of the
    // box's life, into a file nothing ever reads.
    expect(await collectHostedRecordingBeforeRelease("row-1")).not.toBeNull();
  });

  it("walks away from a 409 that belongs to somebody else's take", async () => {
    // THE ONE THAT MATTERS. A daemon reused across iterations can still hold
    // the PREVIOUS iteration's take. Registering blind makes the collector
    // stop that take and upload it as THIS run's video — evidence of the wrong
    // run, which is worse than no evidence because nothing about it looks
    // wrong. Revert the ownership check and this fails.
    const { handle } = fakeHandle({
      record: { ok: false, status: 409, error: "record_active" },
      recordState: { active: true, id: "some-earlier-iteration", fps: 15 },
    });
    await startHostedRecording(handle, {
      connect: async () => fakeSandbox().sandbox,
    });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("walks away from a 409 whose owner the daemon will not name", async () => {
    const { handle } = fakeHandle({
      record: { ok: false, status: 409, error: "record_active" },
      recordState: { active: false },
    });
    await startHostedRecording(handle, {
      connect: async () => fakeSandbox().sandbox,
    });
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("reclaims OUR take even after it stopped at the size cap", async () => {
    // The two fixes meet here. A take that hit `-fs` reports `active: false`
    // while KEEPING its id — it is still ours, and its file is still on the
    // box. Matching the reclaim on `active` rather than on the id would
    // abandon exactly the truncated recording the `truncated` flag exists to
    // deliver: a complete, playable prefix of the run, dropped silently.
    const { handle } = fakeHandle({
      record: { ok: false, status: 409, error: "record_active" },
      recordState: { active: false, id: "sess-1", fps: 15 },
      stopResult: {
        ok: true,
        recording: { ...RECORDING, truncated: true },
      },
    });
    await startHostedRecording(handle, {
      connect: async () => fakeSandbox().sandbox,
    });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toMatchObject({
      truncated: true,
    });
  });

  it("starts a fresh take when the daemon was relaunched under the run", async () => {
    // A per-run daemon can be relaunched mid-run: a new process, no recording,
    // a new bearer. Keyed on the row alone, the stale entry would read as
    // "already recording" — so the rest of the run goes unrecorded and the
    // collector later stops a client pointed at a boot that is gone.
    const deps = { connect: async () => fakeSandbox().sandbox };
    const first = fakeHandle({ bootId: "boot-1" });
    await startHostedRecording(first.handle, deps);
    expect(first.record).toHaveBeenCalledTimes(1);

    const second = fakeHandle({ bootId: "boot-2" });
    await startHostedRecording(second.handle, deps);
    expect(second.record).toHaveBeenCalledWith({
      action: "start",
      id: "sess-1",
      fps: 15,
    });
  });

  it("does not register a start that lands after the deadline gave up", async () => {
    // `Promise.race` does not cancel what it lost to. Without the abandoned
    // flag, a start that finally answers after the deadline writes a registry
    // entry the caller has already given up on — quite possibly after the
    // collector ran and the box was released — leaving an entry for a machine
    // that no longer exists, one that survives `forgetHostedRecording` because
    // it is written after the delete.
    vi.useFakeTimers();
    try {
      const { handle } = fakeHandle();
      let letStatusAnswer: (() => void) | undefined;
      const original = handle.client.status;
      handle.client.status = (() =>
        new Promise((resolve) => {
          letStatusAnswer = () => resolve((original as never as () => unknown)());
        })) as never;

      const starting = startHostedRecording(handle, {
        connect: async () => fakeSandbox().sandbox,
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await starting;

      // ...and only NOW does the box answer.
      letStatusAnswer?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a start that outlasts its deadline", async () => {
    // `ensureLiveBrowserSession` is on the critical path of the turn's FIRST
    // browser action, and the browserd client's own timeout is 75s. Inheriting
    // that would let an unresponsive recorder endpoint hold the agent for over
    // a minute to decide whether to film it.
    vi.useFakeTimers();
    try {
      const { handle } = fakeHandle();
      handle.client.status = (() => new Promise(() => {})) as never;

      const starting = startHostedRecording(handle, {
        connect: async () => fakeSandbox().sandbox,
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await starting;

      expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    const { handle } = fakeHandle({
      stopResult: { ok: false, status: 503, error: "record_unavailable" },
    });
    await startHostedRecording(handle, {
      connect: async () => fakeSandbox().sandbox,
    });

    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
    expect(await collectHostedRecordingBeforeRelease("row-1")).toBeNull();
  });

  it("stops through the client that STARTED the take", async () => {
    // A take belongs to the daemon holding its file. Reading `client.record`
    // afresh at stop time would send the stop to whatever the handle points at
    // by then — after a relaunch, a boot that has no such take — and the file
    // would never be finalised.
    const { handle, record } = fakeHandle();
    await startHostedRecording(handle, {
      connect: async () => fakeSandbox().sandbox,
    });
    const replacement = vi.fn(async () => ({ ok: true, recording: null }));
    handle.client.record = replacement as never;

    expect(await collectHostedRecordingBeforeRelease("row-1")).not.toBeNull();
    expect(replacement).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({ action: "stop" });
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

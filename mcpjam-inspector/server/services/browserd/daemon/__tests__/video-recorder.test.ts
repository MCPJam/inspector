/**
 * The file recorder.
 *
 * Everything here runs without ffmpeg, without an X server and without a
 * filesystem: the process, the clock, the timers and `stat` are all injected.
 * What is under test is the part that would be wrong in a way nobody notices
 * until a run has already lost its evidence — which arguments actually reach
 * ffmpeg, whether a second take can truncate the first, and above all whether
 * `stop` clears the state on every path it can take, including the ones where
 * the encoder is already dead.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  createVideoRecorder,
  parseProgressFrames,
  recorderArgs,
} from "../video-recorder";

/** A stand-in for ffmpeg. */
function fakeFfmpeg(over: { spawnThrows?: boolean } = {}) {
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  const processes: Array<{
    stderr: EventEmitter;
    events: EventEmitter;
    signals: string[];
    exit: (code?: number | null) => void;
  }> = [];
  const spawnProcess = (command: string, args: readonly string[]) => {
    if (over.spawnThrows) {
      const error = new Error("spawn ffmpeg ENOENT") as Error & {
        code?: string;
      };
      error.code = "ENOENT";
      throw error;
    }
    const stderr = new EventEmitter();
    const events = new EventEmitter();
    const signals: string[] = [];
    const entry = {
      stderr,
      events,
      signals,
      exit: (code: number | null = 0) => events.emit("exit", code),
    };
    spawned.push({ command, args });
    processes.push(entry);
    return {
      stderr: { on: (e: string, fn: never) => stderr.on(e, fn) },
      on: (e: string, fn: never) => events.on(e, fn),
      kill: (signal?: string) => {
        signals.push(signal ?? "SIGTERM");
        return true;
      },
    };
  };
  return {
    spawnProcess: spawnProcess as never,
    spawned,
    processes,
    latest: () => processes[processes.length - 1]!,
  };
}

function build(over: Record<string, unknown> = {}) {
  const ffmpeg = fakeFfmpeg(
    (over.spawnThrows as boolean) ? { spawnThrows: true } : {},
  );
  let clock = 1_000;
  const recorder = createVideoRecorder({
    display: ":0",
    width: 1024,
    height: 768,
    dir: "/rec",
    maxBytes: 60 * 1024 * 1024,
    spawnProcess: ffmpeg.spawnProcess,
    statFile: async () => ({ size: 4_096 }),
    now: () => clock,
    ...over,
  });
  return {
    recorder,
    ffmpeg,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the ffmpeg arguments", () => {
  const args = recorderArgs({
    display: ":0",
    width: 1024,
    height: 768,
    fps: 15,
    maxBytes: 60 * 1024 * 1024,
    outputPath: "/rec/run-1.mp4",
  });
  const line = args.join(" ");

  it("grabs the display at the rate it was asked for", () => {
    expect(line).toContain("-f x11grab");
    expect(line).toContain("-framerate 15");
    expect(line).toContain("-video_size 1024x768");
    expect(args[args.length - 1]).toBe("/rec/run-1.mp4");
  });

  it("writes a container a killed box still leaves playable", () => {
    // A plain MP4 keeps its index in a trailing `moov`, so an encoder that is
    // killed leaves an unplayable file — the exact case where the evidence
    // matters most. A fragment per keyframe means a truncated file is a
    // shorter recording rather than no recording.
    expect(line).toContain(
      "-movflags +frag_keyframe+empty_moov+default_base_moof",
    );
    expect(line).toContain("-f mp4");
    // The profile every browser plays with no transcode on the way to the
    // trace viewer.
    expect(line).toContain("-profile:v baseline");
    expect(line).toContain("-pix_fmt yuv420p");
  });

  it("holds an idle page for free and keeps the duration honest", () => {
    // The decimator drops frames identical to the last; variable frame rate
    // keeps their WALL-CLOCK timestamps, so an eight-second think costs
    // nothing, the player holds the last frame across it, and the file's
    // duration still matches the run's. This is what replaces a jitter buffer
    // and a backfill cap.
    expect(line).toContain("-vf mpdecimate");
    expect(line).toContain("-fps_mode vfr");
  });

  it("stops ITSELF at the size cap rather than filling the disk", () => {
    // The alternative is discovering an oversized file at upload time, where
    // the only options left are dropping the evidence or failing the run.
    expect(line).toContain(`-fs ${60 * 1024 * 1024}`);
  });

  it("pins one encoder thread, as the live encoder does", () => {
    expect(args.filter((arg) => arg === "-threads")).toHaveLength(1);
    expect(args[args.indexOf("-threads") + 1]).toBe("1");
  });

  it("asks for machine-readable progress, which is also the orphan guard", () => {
    // `frame=` is where `distinctFrames` comes from. The pipe doubles as the
    // guard: a daemon that dies leaves ffmpeg writing into a closed pipe, and
    // ffmpeg exits on the EPIPE instead of filling the disk.
    expect(line).toContain("-progress pipe:2");
  });

  it("puts a keyframe — and so a fragment — every four seconds", () => {
    expect(args[args.indexOf("-g") + 1]).toBe("60");
    const at30 = recorderArgs({
      display: ":0",
      width: 1024,
      height: 768,
      fps: 30,
      maxBytes: 1,
      outputPath: "/rec/x.mp4",
    });
    expect(at30[at30.indexOf("-g") + 1]).toBe("120");
  });
});

describe("reading the progress pipe", () => {
  it("takes the last complete frame count in a chunk", () => {
    expect(
      parseProgressFrames("frame=12\nfps=15\nframe=19\nprogress=continue\n"),
    ).toBe(19);
  });

  it("ignores a line a chunk boundary cut in half", () => {
    // A monotonic counter: a partial read that finds nothing leaves the
    // previous value standing rather than resetting it to zero.
    expect(parseProgressFrames("fps=15\nfra")).toBeUndefined();
    expect(parseProgressFrames("me=19\n")).toBeUndefined();
  });
});

describe("a take's lifecycle", () => {
  it("spawns exactly one ffmpeg and names the file for the id", () => {
    const { recorder, ffmpeg } = build();
    expect(recorder.start({ id: "run-1", fps: 15 })).toEqual({ ok: true });
    expect(ffmpeg.spawned).toHaveLength(1);
    expect(ffmpeg.spawned[0]!.args).toContain("/rec/run-1.mp4");
    expect(recorder.status()).toMatchObject({
      active: true,
      id: "run-1",
      fps: 15,
    });
  });

  it("refuses a second start instead of truncating the first take", () => {
    // Silently replacing it would truncate a file the caller believes it is
    // still filling, and the caller cannot see that from a 200.
    const { recorder, ffmpeg } = build();
    recorder.start({ id: "run-1", fps: 15 });
    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({
      ok: false,
      error: "record_active",
    });
    expect(ffmpeg.spawned).toHaveLength(1);
  });

  it("ends the take with SIGINT and reports what is on disk", async () => {
    // SIGINT, not SIGTERM: ffmpeg treats it as "finish the file", which
    // flushes the last fragment. SIGTERM would kill it mid-fragment.
    const { recorder, ffmpeg, advance } = build({
      statFile: async () => ({ size: 1_234 }),
    });
    recorder.start({ id: "run-1", fps: 15 });
    ffmpeg.latest().stderr.emit("data", "frame=42\nprogress=continue\n");
    advance(9_000);

    const stopping = recorder.stop();
    await Promise.resolve();
    expect(ffmpeg.latest().signals).toEqual(["SIGINT"]);
    ffmpeg.latest().exit(0);

    expect(await stopping).toEqual({
      path: "/rec/run-1.mp4",
      bytes: 1_234,
      durationMs: 9_000,
      // AFTER decimation: the honest measure of how much the recording shows.
      distinctFrames: 42,
      truncated: false,
    });
    expect(recorder.status()).toEqual({ active: false });
  });

  it("answers null when nothing was recording", async () => {
    const { recorder } = build();
    expect(await recorder.stop()).toBeNull();
  });

  it("reports a take the size cap ended, and clears state anyway", async () => {
    // `-fs` makes ffmpeg stop itself. The file is still on disk and still owed
    // to whoever asked for the take, so this reports it — flagged, never
    // dropped — rather than answering null as if nothing had been recorded.
    const { recorder, ffmpeg, advance } = build({
      statFile: async () => ({ size: 60 * 1024 * 1024 }),
    });
    recorder.start({ id: "run-1", fps: 15 });
    ffmpeg.latest().exit(0);
    advance(300_000);

    const result = await recorder.stop();
    expect(result).toMatchObject({ truncated: true, bytes: 60 * 1024 * 1024 });
    // No second signal: it is already gone.
    expect(ffmpeg.latest().signals).toEqual([]);
    expect(recorder.status()).toEqual({ active: false });
  });

  it("clears the state even when the file cannot be read", async () => {
    // The reference recorder's own lesson. One bad `stat` must not wedge the
    // recorder in "active" forever — that would cost the box every recording
    // it would otherwise have made for the rest of its life.
    const { recorder, ffmpeg } = build({
      statFile: async () => {
        throw new Error("ENOENT");
      },
    });
    recorder.start({ id: "run-1", fps: 15 });
    const stopping = recorder.stop();
    await Promise.resolve();
    ffmpeg.latest().exit(0);

    expect(await stopping).toMatchObject({ bytes: 0 });
    expect(recorder.status()).toEqual({ active: false });
    // ...and the box can record again.
    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({ ok: true });
  });

  it("answers record_unavailable when there is no ffmpeg on the image", () => {
    // A supported state, not a fault: the run simply leaves no video. Same
    // posture as the live encoder's.
    const { recorder } = build({ spawnThrows: true });
    expect(recorder.start({ id: "run-1", fps: 15 })).toEqual({
      ok: false,
      error: "record_unavailable",
    });
    expect(recorder.status()).toEqual({ active: false });
  });

  it("survives an ffmpeg that fails asynchronously", async () => {
    const { recorder, ffmpeg } = build();
    recorder.start({ id: "run-1", fps: 15 });
    ffmpeg.latest().events.emit("error", new Error("spawn ENOENT"));

    expect(await recorder.stop()).toMatchObject({ truncated: true });
    expect(recorder.status()).toEqual({ active: false });
  });
});

describe("shutdown", () => {
  it("lets ffmpeg write its last fragment, then goes", async () => {
    vi.useFakeTimers();
    try {
      const { recorder, ffmpeg } = build();
      recorder.start({ id: "run-1", fps: 15 });

      const finalizing = recorder.finalize({ graceMs: 2_000 });
      await Promise.resolve();
      expect(ffmpeg.latest().signals).toEqual(["SIGINT"]);
      ffmpeg.latest().exit(0);
      await finalizing;

      // It exited within the grace, so nothing was killed.
      expect(ffmpeg.latest().signals).toEqual(["SIGINT"]);
      expect(recorder.status()).toEqual({ active: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("SIGKILLs an encoder that will not answer, rather than blocking the exit", async () => {
    // The daemon is on its way out; waiting forever means the process never
    // leaves and the box is never released. What is on disk stays playable —
    // that is what the fragmented container is for.
    vi.useFakeTimers();
    try {
      const { recorder, ffmpeg } = build();
      recorder.start({ id: "run-1", fps: 15 });

      const finalizing = recorder.finalize({ graceMs: 2_000 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await finalizing;

      expect(ffmpeg.latest().signals).toEqual(["SIGINT", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when nothing is recording", async () => {
    const { recorder, ffmpeg } = build();
    await recorder.finalize({ graceMs: 2_000 });
    expect(ffmpeg.spawned).toHaveLength(0);
  });

  it("refuses to start again once disposed", () => {
    const { recorder, ffmpeg } = build();
    recorder.start({ id: "run-1", fps: 15 });
    recorder.dispose();
    expect(ffmpeg.latest().signals).toEqual(["SIGKILL"]);
    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({
      ok: false,
      error: "record_unavailable",
    });
  });
});

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
  createProgressReader,
  createVideoRecorder,
  recorderArgs,
  FRAGMENT_SECONDS,
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
    // Pinned so a path is assertable. Production takes a random one per boot.
    nonce: "b00t",
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

  it("holds an idle page for almost free", () => {
    // The decimator drops frames identical to the last; variable frame rate
    // keeps their WALL-CLOCK timestamps, so an eight-second think costs
    // almost nothing and the player holds the last frame across it. This is
    // what replaces a jitter buffer and a backfill cap.
    expect(line).toContain("-fps_mode vfr");
    expect(line).toContain("mpdecimate");
  });

  it("keeps a frame even when nothing changes, so the file spans the run", () => {
    // `max` is the floor: the most consecutive frames mpdecimate may drop.
    // WITHOUT it the file ends at the last frame that happened to differ, so a
    // run going quiet for its last five minutes yields a video five minutes
    // shorter than the take — under a header reporting the take's length,
    // which is a reader misled by the evidence. It is ALSO what gives
    // `-force_key_frames` a frame to land on, so the two are one number.
    // Asserted as the exact filter string, because a bare `mpdecimate`
    // substring matches either form.
    expect(line).toContain("-vf mpdecimate=max=60");
    const at30 = recorderArgs({
      display: ":0",
      width: 1024,
      height: 768,
      fps: 30,
      maxBytes: 1,
      outputPath: "/rec/x.mp4",
    });
    // FRAGMENT_SECONDS worth at any rate, not a fixed frame count.
    expect(at30.join(" ")).toContain("-vf mpdecimate=max=120");
  });

  it("derives the floor, the forced keyframe and the GOP from ONE number", () => {
    // THE COUPLING IS THE POINT. `-force_key_frames` can only mark a frame
    // that EXISTS; the decimation floor is what makes one exist on a page that
    // never changes. Set the floor looser than the boundary and IT becomes the
    // real cadence — the four-second promise silently widens to whatever the
    // floor is, which is exactly how this was wrong before. Three literals
    // that must agree are three chances to drift, so there is now one.
    for (const fps of [1, 15, 30]) {
      const line = recorderArgs({
        display: ":0",
        width: 800,
        height: 600,
        fps,
        maxBytes: 1,
        outputPath: "/rec/x.mp4",
      }).join(" ");
      expect(line).toContain(
        `-vf mpdecimate=max=${fps * FRAGMENT_SECONDS}`,
      );
      expect(line).toContain(`-g ${fps * FRAGMENT_SECONDS}`);
      expect(line).toContain(
        `-force_key_frames expr:gte(t,n_forced*${FRAGMENT_SECONDS})`,
      );
    }
  });

  it("stops ITSELF at the size cap rather than filling the disk", () => {
    // The alternative is discovering an oversized file at upload time, where
    // the only options left are dropping the evidence or failing the run.
    expect(line).toContain(`-fs ${60 * 1024 * 1024}`);
  });

  it("overwrites an existing file rather than stalling on a prompt", () => {
    // Without `-y` ffmpeg asks "File exists. Overwrite?" — and with stdin
    // ignored that is a process which writes nothing and exits, AFTER `start`
    // has already answered `ok`. A reused id means the previous take is
    // finished with.
    expect(args).toContain("-y");
    expect(args.indexOf("-y")).toBeLessThan(args.length - 1);
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

  it("puts a fragment every four seconds OF WALL CLOCK, not of frames", () => {
    // THE LOAD-BEARING ONE. `-g` counts ENCODED frames, and decimation makes
    // those arbitrarily far apart in wall-clock terms — sixty of them can
    // span minutes of a quiet page, so `-g` alone would write a fragment that
    // rarely and a killed box would lose everything since the last one.
    // `-force_key_frames` is on presentation time, which IS the wall clock
    // here because `-fps_mode vfr` preserves it.
    expect(line).toContain("-force_key_frames expr:gte(t,n_forced*4)");
    // `-g` stays as the ceiling for a busy page, where 60 frames is four
    // seconds, and `-sc_threshold 0` stops the cadence drifting on content.
    expect(args[args.indexOf("-g") + 1]).toBe("60");
    expect(line).toContain("-sc_threshold 0");
    const at30 = recorderArgs({
      display: ":0",
      width: 1024,
      height: 768,
      fps: 30,
      maxBytes: 1,
      outputPath: "/rec/x.mp4",
    });
    expect(at30[at30.indexOf("-g") + 1]).toBe("120");
    // The forced cadence is in SECONDS, so it does not move with the rate.
    expect(at30.join(" ")).toContain("-force_key_frames expr:gte(t,n_forced*4)");
  });
});

describe("reading the progress pipe", () => {
  it("takes the last complete frame count in a chunk", () => {
    const reader = createProgressReader();
    expect(
      reader.push("frame=12\nfps=15\nframe=19\nprogress=continue\n"),
    ).toBe(19);
  });

  it("rejoins a line a chunk boundary cut in half", () => {
    // THE LOAD-BEARING ONE. A `data` event can split anywhere, and at a real
    // frame rate that is not rare — parsing each chunk on its own drops BOTH
    // halves and under-reports `distinctFrames` on exactly the busy recordings
    // where the number matters. Revert the reader to a per-chunk parse and
    // this fails.
    const reader = createProgressReader();
    expect(reader.push("fps=15\nfra")).toBeUndefined();
    expect(reader.push("me=19\nprogress=continue\n")).toBe(19);
  });

  it("holds a partial line across several chunks", () => {
    const reader = createProgressReader();
    expect(reader.push("fr")).toBeUndefined();
    expect(reader.push("am")).toBeUndefined();
    expect(reader.push("e=7")).toBeUndefined();
    expect(reader.push("\n")).toBe(7);
  });

  it("leaves the previous value standing when a chunk carries no count", () => {
    // A monotonic counter upstream: `undefined` means "nothing new", never
    // "zero frames".
    const reader = createProgressReader();
    expect(reader.push("bitrate=800k\nspeed=1x\n")).toBeUndefined();
  });
});

describe("a take's lifecycle", () => {
  it("spawns exactly one ffmpeg and names the file for the id", () => {
    const { recorder, ffmpeg } = build();
    expect(recorder.start({ id: "run-1", fps: 15 })).toEqual({ ok: true });
    expect(ffmpeg.spawned).toHaveLength(1);
    expect(ffmpeg.spawned[0]!.args).toContain("/rec/run-1-b00t-1.mp4");
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
      path: "/rec/run-1-b00t-1.mp4",
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

  it("stops calling a dead take `active`", async () => {
    // `-fs` makes ffmpeg stop itself. Until `stop` is called the take is still
    // the recorder's to report on — but a poller asking "is a recording being
    // made?" must not be told yes when nothing is being written.
    const { recorder, ffmpeg } = build();
    recorder.start({ id: "run-1", fps: 15 });
    expect(recorder.status()).toMatchObject({ active: true, id: "run-1" });

    ffmpeg.latest().exit(0);

    expect(recorder.status()).toMatchObject({ active: false, id: "run-1" });
  });

  it("refuses a start while the previous stop is still in flight", async () => {
    // `stop` clears `take` before its first await so a filesystem hang cannot
    // wedge the recorder — which alone would let a start in that window spawn
    // a SECOND ffmpeg onto the same display, the loser overwriting the
    // winner's file.
    const { recorder, ffmpeg } = build();
    recorder.start({ id: "run-1", fps: 15 });

    const stopping = recorder.stop();
    await Promise.resolve();
    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({
      ok: false,
      error: "record_active",
    });
    expect(ffmpeg.spawned).toHaveLength(1);

    ffmpeg.latest().exit(0);
    await stopping;

    // ...and the slot frees once the old process is actually gone.
    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({ ok: true });
  });

  it("frees the slot when ffmpeg exits, however long the file read takes", async () => {
    // The lock is about a second ENCODER on one display, and that risk ends
    // when the old process exits. Holding it across `stat` would reintroduce
    // the wedge that clearing `take` before the first await exists to prevent:
    // a hung read would refuse every later start with `record_active` while
    // nothing at all was recording.
    let releaseStat: (() => void) | undefined;
    const { recorder, ffmpeg } = build({
      statFile: () =>
        new Promise<{ size: number }>((resolve) => {
          releaseStat = () => resolve({ size: 10 });
        }),
    });
    recorder.start({ id: "run-1", fps: 15 });

    const stopping = recorder.stop();
    await Promise.resolve();
    ffmpeg.latest().exit(0);
    // Let the `exited` continuation that frees the lock run. The stat is still
    // outstanding at this point — that is the whole shape of the test.
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({ ok: true });
    releaseStat?.();
    await stopping;
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

  it("seals the recorder, so a start during shutdown spawns nothing", async () => {
    // The HTTP server is still accepting while `finalize` awaits its grace. A
    // take started here is one nothing will finalise — `process.exit(0)` is
    // moments away — leaving a zero-length file and an orphan on a box about
    // to be reclaimed.
    vi.useFakeTimers();
    try {
      const { recorder, ffmpeg } = build();
      recorder.start({ id: "run-1", fps: 15 });

      const finalizing = recorder.finalize({ graceMs: 2_000 });
      expect(recorder.start({ id: "run-2", fps: 15 })).toEqual({
        ok: false,
        error: "record_unavailable",
      });
      ffmpeg.latest().exit(0);
      await finalizing;

      expect(ffmpeg.spawned).toHaveLength(1);
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

/**
 * Every take owns its file.
 *
 * The stop lock releases when ffmpeg exits, so a same-id start can spawn while
 * the previous take's `stat` — and the inspector's read of the file, later
 * still — are outstanding. Sharing one path let the new encoder truncate the
 * old recording under both of them: the old stop would report the NEW take's
 * size, and the collector would upload the new take as the old run's evidence.
 */
describe("each take writes its own file", () => {
  it("never reuses a path, even for the same id", async () => {
    // The window, exactly: ffmpeg has exited (so the lock is free and a new
    // take may start) while the old take's `stat` — and the collector's read
    // of the file, much later — are still outstanding.
    let releaseStat: (() => void) | undefined;
    const { recorder, ffmpeg } = build({
      statFile: () =>
        new Promise<{ size: number }>((resolve) => {
          releaseStat = () => resolve({ size: 10 });
        }),
    });
    recorder.start({ id: "run-1", fps: 15 });

    const stopping = recorder.stop();
    await Promise.resolve();
    ffmpeg.latest().exit(0);
    await Promise.resolve();
    await Promise.resolve();

    // Same id, because that is the case a shared path loses: a retry of the
    // same run, or a second attempt under the same recording id.
    expect(recorder.start({ id: "run-1", fps: 15 })).toEqual({ ok: true });

    const paths = ffmpeg.spawned.map((s) => s.args[s.args.length - 1]);
    expect(paths).toEqual(["/rec/run-1-b00t-1.mp4", "/rec/run-1-b00t-2.mp4"]);
    expect(new Set(paths).size).toBe(2);

    releaseStat?.();
    // The first take still reports ITS file, not the one now being written.
    expect((await stopping)?.path).toBe("/rec/run-1-b00t-1.mp4");
  });

  it("does not reuse the previous BOOT's path when the counter resets", async () => {
    // The counter is per-process; the recording directory is not. A relaunched
    // browserd starts again at take 1, and `-y` would truncate the earlier
    // boot's file under a collector still reading it — which then uploads
    // bytes that are not the take whose size it was told.
    const first = build();
    first.recorder.start({ id: "run-1", fps: 15 });

    // A whole new daemon over the same directory. Nothing is shared but `dir`.
    const second = build({ nonce: "b00t2" });
    second.recorder.start({ id: "run-1", fps: 15 });

    const pathOf = (f: ReturnType<typeof fakeFfmpeg>) =>
      f.spawned[0]!.args[f.spawned[0]!.args.length - 1];
    expect(pathOf(first.ffmpeg)).toBe("/rec/run-1-b00t-1.mp4");
    expect(pathOf(second.ffmpeg)).toBe("/rec/run-1-b00t2-1.mp4");
    expect(pathOf(first.ffmpeg)).not.toBe(pathOf(second.ffmpeg));
  });

  it("names every take for the process that wrote it, without being told", () => {
    // No `nonce` here — the real one. Two recorders over one directory must
    // still not collide, or the guarantee holds only in tests.
    const paths = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const ffmpeg = fakeFfmpeg();
      const recorder = createVideoRecorder({
        display: ":0",
        width: 1024,
        height: 768,
        dir: "/rec",
        maxBytes: 1_000,
        spawnProcess: ffmpeg.spawnProcess,
        statFile: async () => ({ size: 1 }),
      });
      recorder.start({ id: "run-1", fps: 15 });
      const args = ffmpeg.spawned[0]!.args;
      paths.add(args[args.length - 1]!);
    }
    expect(paths.size).toBe(8);
  });

  it("reports the path it actually wrote, so a reader never rebuilds it", async () => {
    const { recorder, ffmpeg } = build({ statFile: async () => ({ size: 7 }) });
    recorder.start({ id: "run-1", fps: 15 });
    const stopping = recorder.stop();
    await Promise.resolve();
    ffmpeg.latest().exit(0);

    const result = await stopping;
    expect(result?.path).toBe("/rec/run-1-b00t-1.mp4");
    expect(ffmpeg.spawned[0]!.args).toContain(result!.path);
  });
});

/**
 * A recording of the X display, written to a file, as run evidence.
 *
 * WHY A SECOND FFMPEG RATHER THAN A SINK ON THE LIVE ENCODER. The live encoder
 * next door (`video-encoder.ts`) is demand-driven: it starts on the first
 * watcher and stops on the last, restarts whole on a tier change and on any
 * exit, and keeps exactly one GOP. Every one of those is right for a person
 * watching and fatal for a file — a tier change mid-run would truncate the
 * recording to zero bytes and start again, and the last watcher leaving would
 * end it. A recording has a different lifecycle from a stream because it has a
 * different owner: the RUN, not a pane. And on the box this is actually for —
 * a per-run hosted browser for an unattended eval — there is no pane at all,
 * so this is the only encoder running and the two never compete.
 *
 * WHY FRAGMENTED MP4. The box can be killed at any moment (a suite that runs
 * long, a hosted sandbox reclaimed, the daemon SIGTERMed). A plain MP4 keeps
 * its index in a `moov` atom written at the END, so a killed encoder leaves an
 * unplayable file — the exact case where the evidence matters most.
 * `+frag_keyframe+empty_moov+default_base_moof` writes a playable fragment
 * every keyframe, so a truncated file is a shorter recording rather than no
 * recording. H.264 baseline in MP4 is what every browser plays with no
 * transcode on the way to the trace viewer.
 *
 * WHY `mpdecimate` AND VARIABLE FRAME RATE. An agent's browser is idle most of
 * the time: it navigates, then thinks for eight seconds, then clicks. A
 * constant-rate encode of that is mostly duplicate frames, and it is the
 * duplicates that fill the size cap. The decimator drops frames identical to
 * the last, and `-fps_mode vfr` keeps their WALL-CLOCK timestamps — so the
 * idle gap costs nothing, the last frame is held across it by the player, and
 * the file's duration still matches the run's. Holding the last frame and
 * getting the duration right fall out of the container rather than needing a
 * pacing loop, which is why there is no jitter buffer or backfill cap here.
 *
 * WHAT `distinctFrames` MEANS. The frames ffmpeg actually WROTE, read off its
 * `-progress` pipe — after decimation, so a static ten-minute run reports a
 * handful against six hundred seconds. Reported rather than smoothed: it is
 * the honest measure of how much a recording actually shows, and the pipe
 * doubles as an orphan guard (a daemon that dies leaves ffmpeg writing into a
 * closed pipe, and ffmpeg exits on the EPIPE rather than filling a disk).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * The slice of a child process this module uses.
 *
 * Narrower than `ChildProcessWithoutNullStreams` for the same reason the
 * encoder's is: `spawn`'s return type depends on the exact stdio tuple, and a
 * test double should not have to satisfy an EventEmitter's whole surface.
 */
export interface RecorderProcess {
  stderr: Pick<Readable, "on">;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Why a start was refused. Both are states, not faults. */
export type RecorderStartError = "record_active" | "record_unavailable";

export interface RecorderStartArgs {
  /** Names the file. Validated as a filename by the route before it gets here. */
  id: string;
  fps: number;
}

export interface RecordingResult {
  path: string;
  bytes: number;
  /** Wall clock from start to stop, which is what the file's timeline covers. */
  durationMs: number;
  /** Frames ffmpeg wrote, AFTER decimation. See the note above. */
  distinctFrames: number;
  /**
   * The take ended before anything asked it to.
   *
   * Covers both the size cap (`-fs`) and a crash — `bytes` disambiguates: at
   * the cap it is ~`maxBytes`, on a crash it is whatever had been flushed. A
   * truncated recording is still a recording: the fragmented container keeps
   * it playable, and the caller says so beside it rather than dropping it.
   */
  truncated: boolean;
}

export interface RecorderStatus {
  active: boolean;
  id?: string;
  fps?: number;
  startedAtMs?: number;
  distinctFrames?: number;
}

export interface VideoRecorderOptions {
  /** The X display to grab, e.g. `":0"`. */
  display: string;
  width: number;
  height: number;
  /** Where recordings are written. One file per take, per boot. */
  dir: string;
  /** `-fs`: the encoder stops itself here rather than filling the disk. */
  maxBytes: number;
  /** Injected so a test needs neither ffmpeg nor an X server. */
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { stdio: readonly ["ignore", "ignore", "pipe"] },
  ) => RecorderProcess;
  ffmpegPath?: string;
  /** Injected for the same reason: the size of a file no test wrote. */
  statFile?: (path: string) => Promise<{ size: number }>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Namespaces this process's take files. Random per recorder, which is per
   * daemon boot; injected only so a test can assert an exact path.
   */
  nonce?: string;
}

export interface VideoRecorder {
  start(args: RecorderStartArgs): { ok: true } | { ok: false; error: RecorderStartError };
  /**
   * End the take and report what is on disk.
   *
   * `null` when nothing was recording. Never throws: a stop that cannot read
   * its own file still has to clear the state, or the box records nothing for
   * the rest of its life over one bad `stat`.
   */
  stop(): Promise<RecordingResult | null>;
  status(): RecorderStatus;
  /**
   * Shutdown: end any take within `graceMs`, then SIGKILL.
   *
   * Bounded because this runs on the daemon's exit path, where waiting forever
   * means the process never leaves and the box is never released. A file cut
   * short by the SIGKILL is still playable — that is what the fragmented
   * container is for.
   *
   * SEALS the recorder: the server is still accepting requests while this
   * awaits, and a take started during shutdown is one nothing would finalise.
   */
  finalize(args?: { graceMs?: number }): Promise<void>;
  dispose(): void;
}

/** Bounds on `fps`, enforced at the route before any spawn. */
export const MIN_RECORD_FPS = 1;
export const MAX_RECORD_FPS = 30;
export const DEFAULT_RECORD_FPS = 15;

/**
 * The fragment interval, in seconds — and the ONLY number that sets it.
 *
 * Three arguments have to agree for `+frag_keyframe` to mean "a killed box
 * loses at most this long", and when they were three separate literals they
 * did not:
 *
 *   - `-force_key_frames` forces a keyframe at each boundary, but only ever on
 *     a frame that EXISTS.
 *   - `mpdecimate=max=` is what makes one exist on a page that never changes.
 *     Set looser than the boundary, it becomes the real cadence and the
 *     promise quietly widens to whatever it was.
 *   - `-g` bounds the same thing for a busy page, where the frames are there
 *     anyway and the count is what matters.
 *
 * So they are derived from this, and cannot drift apart again.
 */
export const FRAGMENT_SECONDS = 4;

/** How long shutdown waits for ffmpeg to write its last fragment. */
export const DEFAULT_FINALIZE_GRACE_MS = 2_000;

/**
 * The full argument list.
 *
 * Exported so a test can read it rather than a comment describing it, exactly
 * as `ffmpegArgs` is. The non-obvious ones:
 *
 *   `-progress pipe:2`  machine-readable `frame=`/`out_time_us=` on stderr. It
 *                       is where `distinctFrames` comes from, and it is also
 *                       the orphan guard: a daemon that dies leaves ffmpeg
 *                       writing into a closed pipe, and ffmpeg exits on the
 *                       EPIPE instead of filling the disk with a recording
 *                       nobody will ever read.
 *   `mpdecimate=max=`   with `-fps_mode vfr`: an idle page emits almost
 *                       nothing while timestamps stay on the wall clock, so
 *                       the player holds the last frame across the gap.
 *                       `max` is the floor — at most that many consecutive
 *                       frames may be dropped, so a keeper lands every
 *                       `FRAGMENT_SECONDS` however still the screen is, which
 *                       is also what gives `-force_key_frames` a frame to
 *                       land on. Without it the file ENDS
 *                       at the last frame that happened to differ: a run that
 *                       goes quiet for its last five minutes would produce a
 *                       video five minutes shorter than the take, under a
 *                       header reporting the take's length. The floor costs
 *                       fifteen near-identical frames a minute, which
 *                       compress to almost nothing.
 *   `-threads 1`        the same rule the live encoder follows: one thread at
 *                       or below 30fps, so the encoder never starves the
 *                       capture loop feeding it on a 2 vCPU box.
 *   `-force_key_frames` a keyframe every four seconds OF PRESENTATION TIME,
 *                       which with `+frag_keyframe` is the fragment interval,
 *                       so a killed box loses at most four seconds. `-g`
 *                       cannot do this job alone: it counts ENCODED frames,
 *                       and decimation makes those arbitrarily far apart in
 *                       wall-clock terms — sixty of them can span minutes of
 *                       a quiet page. It stays as the ceiling for a busy one.
 *   `-crf 28 -maxrate`  evidence, not cinema: legible at 60 MiB for a run of
 *                       real length.
 *   `-fs <maxBytes>`    ffmpeg stops ITSELF at the cap. The alternative is
 *                       discovering a 200 MiB file at upload time, where the
 *                       only options left are dropping it or failing the run.
 */
export function recorderArgs(options: {
  display: string;
  width: number;
  height: number;
  fps: number;
  maxBytes: number;
  outputPath: string;
}): string[] {
  return [
    "-loglevel",
    "error",
    "-progress",
    "pipe:2",
    "-f",
    "x11grab",
    "-framerate",
    String(options.fps),
    "-video_size",
    `${options.width}x${options.height}`,
    "-draw_mouse",
    "1",
    "-i",
    options.display,
    "-vf",
    // `max`: the most consecutive frames mpdecimate may drop — the floor
    // that gives `-force_key_frames` below something to land on.
    `mpdecimate=max=${options.fps * FRAGMENT_SECONDS}`,
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-threads",
    "1",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(options.fps * FRAGMENT_SECONDS),
    "-sc_threshold",
    "0",
    // Wall clock, not frame count — the only one of the three that survives
    // decimation. `t` is the frame's presentation time in seconds.
    "-force_key_frames",
    `expr:gte(t,n_forced*${FRAGMENT_SECONDS})`,
    "-crf",
    "28",
    "-maxrate",
    "800k",
    "-bufsize",
    "1600k",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-fs",
    String(options.maxBytes),
    "-f",
    "mp4",
    // OVERWRITE. Without it ffmpeg stops at an interactive "File exists?"
    // prompt on a reused id — with stdin ignored that is a process that writes
    // nothing and exits, AFTER `start` has already answered `ok`. A take that
    // reuses an id means the previous one is finished with; replacing it is
    // the only reading under which the answer stays true.
    "-y",
    options.outputPath,
  ];
}

/**
 * Read `frame=<n>` off an ffmpeg `-progress` stream, across chunk boundaries.
 *
 * The pipe is line-oriented `key=value`, written in blocks ending `progress=`,
 * and a `data` event can split a line anywhere — `fra` in one chunk and `me=19`
 * in the next. Parsing each chunk independently drops BOTH halves, and at a
 * high enough frame rate the split is not rare: it would quietly under-report
 * `distinctFrames` on exactly the busy recordings where the number matters.
 *
 * So this is a stateful reader: it holds the trailing partial line and prefixes
 * it onto the next chunk. Returns the LAST complete `frame=` it can see, or
 * `undefined` — the caller keeps a monotonic counter, so a chunk carrying no
 * complete line simply leaves the previous value standing.
 */
export function createProgressReader(): {
  push(chunk: string): number | undefined;
} {
  let pending = "";
  return {
    push(chunk) {
      const text = pending + chunk;
      // Everything up to the last newline is complete; the remainder is a
      // partial line waiting for the rest of itself.
      const lastBreak = text.lastIndexOf("\n");
      if (lastBreak < 0) {
        pending = text;
        return undefined;
      }
      pending = text.slice(lastBreak + 1);
      let found: number | undefined;
      for (const line of text.slice(0, lastBreak).split("\n")) {
        const match = /^frame=\s*(\d+)\s*$/.exec(line.trim());
        if (!match) continue;
        const value = Number(match[1]);
        if (Number.isFinite(value)) found = value;
      }
      return found;
    },
  };
}

interface ActiveTake {
  id: string;
  fps: number;
  path: string;
  startedAtMs: number;
  child: RecorderProcess;
  distinctFrames: number;
  /** Resolves when the child has exited, however it exited. */
  exited: Promise<void>;
  settleExit: () => void;
  /** The process is gone and nothing asked it to go. */
  endedEarly: boolean;
}

export function createVideoRecorder(
  options: VideoRecorderOptions,
): VideoRecorder {
  const spawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], {
        stdio: [...spawnOptions.stdio],
      }) as unknown as RecorderProcess);
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const statFile =
    options.statFile ?? (async (path: string) => stat(path));
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  let take: ActiveTake | undefined;
  /**
   * Held while a stopped take's ffmpeg is still alive.
   *
   * `stop` clears `take` before its first await — deliberately, so a hang on
   * the filesystem cannot wedge the recorder in "active" forever. That alone
   * would let a `start` arriving during the stop spawn a SECOND ffmpeg while
   * the first is still writing: two encoders on one display, and the loser
   * overwrites the winner's file.
   *
   * SCOPED TO THE PROCESS, NOT TO THE WHOLE STOP. What this protects against
   * is a second encoder, and that risk ends the moment the old one exits —
   * everything after that (the `stat`) only reads a file. Holding it across
   * the read would reintroduce the very wedge clearing `take` early exists to
   * prevent: a hung `stat` would refuse every later start with
   * `record_active` while nothing at all was recording.
   */
  let stopping: Promise<unknown> | undefined;
  /**
   * Monotonic, so every take gets a FILE OF ITS OWN.
   *
   * Naming the file for the id alone made the path mutable: once the lock
   * above releases at process exit, a same-id start can spawn and (with `-y`)
   * truncate the previous take's `.mp4` while its `stat` — and the
   * inspector's read, which happens later still — are outstanding. The old
   * stop would then report the NEW recording's size, and the collector would
   * upload the new take as the old run's evidence.
   *
   * An immutable path per take removes the race outright rather than locking
   * around it, and costs nothing: the result carries `path`, and every reader
   * uses it rather than rebuilding the name.
   */
  let takeSeq = 0;
  /**
   * And the counter alone is not enough, because it RESETS when the daemon
   * restarts. A relaunched browserd mid-run writes `<id>-1.mp4` again, and
   * `-y` truncates the previous boot's take under whoever is still reading it
   * — the collector then uploads bytes that are not the take whose size and
   * duration were reported to it. The recording directory outlives the
   * process, so the name has to say WHICH process wrote it.
   *
   * NOTHING HERE DELETES A TAKE, AND THAT IS DELIBERATE. Unique names mean the
   * directory grows by a take per boot, which is a real cost — so this did
   * once sweep old files, twice, and both versions could delete a recording a
   * collector was still reading. The reason is structural rather than a bug to
   * fix: the read happens over the sandbox files API, entirely outside this
   * process, and no signal from it ever reaches the daemon. Age does not
   * stand in for one either, because a take that hits `-fs` stops being
   * written the moment it caps and can sit, finished and still owed, for the
   * rest of a long attempt.
   *
   * Any horizon short enough to reclaim disk is therefore short enough to
   * delete evidence; any horizon long enough to be safe outlives the box
   * itself, so it would never fire. And the files that actually pile up are
   * the ones never collected — which is precisely what the daemon cannot
   * distinguish from not collected YET.
   *
   * So the bound is the box's own lifetime. These are per-run sandboxes that
   * are released minutes later, each take is capped at `maxBytes`, and a
   * normal run writes exactly one. Growth needs a crash-looping browserd on a
   * box that is already failing. That is the cheaper thing to be wrong about.
   */
  let disposed = false;

  const start = (
    args: RecorderStartArgs,
  ): { ok: true } | { ok: false; error: RecorderStartError } => {
    if (disposed) return { ok: false, error: "record_unavailable" };
    // IDEMPOTENCE IS THE CALLER'S, not ours. A second start is refused rather
    // than silently replacing the take, because replacing one would truncate a
    // file the caller believes it is still filling — and the caller cannot see
    // that from a 200. `stopping` covers the window after `stop` cleared
    // `take` and before the old ffmpeg is actually gone.
    if (take || stopping) return { ok: false, error: "record_active" };
    takeSeq += 1;
    // `-y` stays, but as a belt rather than the braces: it makes ffmpeg
    // overwrite instead of stalling on a prompt, and overwriting is precisely
    // what must never reach another boot's file — hence the nonce.
    const path = join(options.dir, `${args.id}-${nonce}-${takeSeq}.mp4`);
    let child: RecorderProcess;
    try {
      child = spawnProcess(
        ffmpegPath,
        recorderArgs({
          display: options.display,
          width: options.width,
          height: options.height,
          fps: args.fps,
          maxBytes: options.maxBytes,
          outputPath: path,
        }),
        // stdout ignored: everything this process says rides the progress pipe
        // on stderr, and the video goes to a file.
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch {
      // No ffmpeg on this image is a SUPPORTED state, not a fault: the run
      // simply leaves no video, and the caller is told so rather than the
      // daemon refusing to work. Same posture as the live encoder's.
      return { ok: false, error: "record_unavailable" };
    }
    let settleExit = (): void => {};
    const exited = new Promise<void>((resolve) => {
      settleExit = resolve;
    });
    const entry: ActiveTake = {
      id: args.id,
      fps: args.fps,
      path,
      startedAtMs: now(),
      child,
      distinctFrames: 0,
      exited,
      settleExit,
      endedEarly: false,
    };
    take = entry;
    child.on("error", () => {
      if (take !== entry) return;
      // A spawn that failed asynchronously (ENOENT on some platforms arrives
      // here rather than as a throw). The take is over; `stop` still reports
      // it, and `truncated` says it ended before anything asked.
      entry.endedEarly = true;
      entry.settleExit();
    });
    child.on("exit", () => {
      entry.settleExit();
      if (take !== entry) return;
      // The `-fs` cap, a crash, or the box running out of disk. Recorded, NOT
      // cleared: the file is still on disk and still owed to whoever asked for
      // this take, so `stop` reports it (and says it was cut short) rather
      // than answering `null` as if nothing had ever been recorded.
      entry.endedEarly = true;
    });
    const progress = createProgressReader();
    child.stderr.on("data", (chunk: Buffer | string) => {
      const frames = progress.push(String(chunk));
      if (frames !== undefined) entry.distinctFrames = frames;
    });
    return { ok: true };
  };

  const stop = async (): Promise<RecordingResult | null> => {
    const entry = take;
    // CLEARED FIRST, before any await. A stop that throws or hangs on the
    // filesystem must not leave the recorder wedged in "active" forever —
    // that would mean one bad `stat` costs the box every recording it would
    // otherwise have made. This is the reference recorder's own lesson.
    take = undefined;
    if (!entry) return null;
    // Released when the PROCESS is gone, not when this call returns: a start
    // arriving after ffmpeg has exited can spawn safely, however long the
    // file read that follows takes.
    const processGone: Promise<void> = entry.exited.then(() => {
      if (stopping === processGone) stopping = undefined;
    });
    stopping = processGone;
    return runStop(entry);
  };

  const runStop = async (entry: ActiveTake): Promise<RecordingResult> => {
    if (!entry.endedEarly) {
      try {
        // SIGINT, not SIGTERM: ffmpeg treats it as "finish the file", which
        // flushes the last fragment and writes a clean end. SIGTERM would kill
        // it mid-fragment.
        entry.child.kill("SIGINT");
      } catch {
        // Already gone; the `exit` handler has settled `exited`.
      }
    }
    await entry.exited;
    // THE TAKE'S WALL-CLOCK SPAN, not the container's. The two can differ:
    // the file ends at its last frame, and only the `mpdecimate` floor keeps
    // that within `FRAGMENT_SECONDS` of the stop. Wall clock is the honest number for a
    // reader asking how long the run was, and it is the only one the daemon
    // knows without probing the file it just wrote.
    const durationMs = Math.max(0, now() - entry.startedAtMs);
    let bytes = 0;
    try {
      bytes = (await statFile(entry.path)).size;
    } catch {
      // A take that produced no file at all (ffmpeg died before its first
      // fragment). Reported as zero bytes rather than as a failure — the
      // caller decides whether zero is worth uploading, and it needs the
      // duration and the frame count to decide.
      bytes = 0;
    }
    return {
      path: entry.path,
      bytes,
      durationMs,
      distinctFrames: entry.distinctFrames,
      truncated: entry.endedEarly,
    };
  };

  return {
    start,
    stop,
    status() {
      // `endedEarly` means ffmpeg is gone — the size cap, or a crash. The take
      // is still the recorder's to report on (`stop` owes the caller its file),
      // but saying `active: true` would tell a poller that a recording is
      // still being made when nothing is being written. The id and the numbers
      // stay, so the answer is "this take, and it has stopped".
      if (!take) return { active: false };
      return {
        active: !take.endedEarly,
        id: take.id,
        fps: take.fps,
        startedAtMs: take.startedAtMs,
        distinctFrames: take.distinctFrames,
      };
    },
    async finalize(args) {
      // SEALED FIRST. The HTTP server is still accepting while this awaits its
      // grace, so a `POST /v1/record start` landing here would spawn an ffmpeg
      // nothing will ever finalise — `process.exit(0)` is moments away, and it
      // would leave a zero-length file and an orphan process on a box that is
      // about to be reclaimed. After finalize there is no more recording to be
      // had from this daemon, so saying so is the honest state.
      disposed = true;
      const entry = take;
      if (!entry) return;
      take = undefined;
      if (entry.endedEarly) return;
      try {
        entry.child.kill("SIGINT");
      } catch {
        return;
      }
      const graceMs = args?.graceMs ?? DEFAULT_FINALIZE_GRACE_MS;
      let timer: unknown;
      await Promise.race([
        entry.exited,
        new Promise<void>((resolve) => {
          timer = setTimer(() => {
            // Silence past the grace: something is wrong with the encoder and
            // the daemon is on its way out. SIGKILL it and go — the fragmented
            // container means what is on disk is still playable.
            try {
              entry.child.kill("SIGKILL");
            } catch {
              // Already gone.
            }
            resolve();
          }, graceMs);
        }),
      ]);
      clearTimer(timer);
    },
    dispose() {
      disposed = true;
      const entry = take;
      take = undefined;
      if (!entry || entry.endedEarly) return;
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

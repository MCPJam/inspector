/**
 * H.264 off the X display, for the human pane.
 *
 * WHY THE DISPLAY AND NOT THE PAGE. The daemon already produces CDP screencast
 * frames, and re-encoding those would be the obvious source. It is the wrong
 * one here for three reasons, and the first is decisive: the screencast shows
 * the PAGE, so a native file chooser, a print dialog, a permission prompt or a
 * download bar — every moment a person actually needs to take over — is
 * invisible in it. The X display is exactly the page size (Xvfb is started at
 * the observation viewport's geometry) with Chromium in kiosk covering it, so
 * "the display IS the page" plus everything drawn on top of it. It also skips a
 * decode→encode hop, and it leaves the CDP screencast entirely free for the
 * model's own path.
 *
 * WHY JPEG STAYS. This is a capability, not a replacement. A box with no ffmpeg
 * on the image, a client with no `VideoDecoder`, or the kill switch answers
 * `video_unavailable` and every watcher falls back to the screencast — which is
 * also why per-tab watching stays JPEG-only: a display grab has no concept of a
 * tab, so `codec=h264` is always the ACTIVE one.
 *
 * WHAT COMES OUT. Annex-B, split into access units on the AUD (NAL 9) that
 * `-x264-params aud=1` makes x264 emit. Parameter sets ride in front of every
 * key unit (`repeat-headers=1`), so a subscriber that joins mid-stream has
 * everything it needs in the one record it starts from — and the ring below
 * makes sure that record is never far away.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * The slice of a child process this module uses.
 *
 * Narrower than `ChildProcessWithoutNullStreams` on purpose: `spawn`'s return
 * type depends on the exact `stdio` tuple, and a test double should not have to
 * satisfy an EventEmitter's whole surface to stand in for one.
 */
interface EncoderProcess {
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** How the encoder is asked to trade bitrate against sharpness. */
export type VideoTier = "auto" | "sharp" | "saver";

export interface VideoAccessUnit {
  /** Contains an IDR: a decoder can start here. */
  key: boolean;
  /** Annex-B bytes, parameter sets included on a key unit. */
  bytes: Uint8Array;
}

export interface VideoEncoderOptions {
  /** The X display to grab, e.g. `":0"`. */
  display: string;
  /** The display's own size. The grab is the whole screen. */
  width: number;
  height: number;
  tier?: VideoTier;
  /** Injected so a test needs neither ffmpeg nor an X server. */
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { stdio: readonly ["ignore", "pipe", "pipe"] },
  ) => EncoderProcess;
  /** Where to find ffmpeg. Overridable for the same reason. */
  ffmpegPath?: string;
}

export interface VideoEncoder {
  /**
   * Watch the encoder. The first subscriber starts ffmpeg and the last one to
   * leave stops it — the same demand-driven lifecycle the screencast has, and
   * for the same reason: an encoder running for nobody is CPU the agent is
   * also trying to use.
   *
   * A new subscriber is replayed the current GOP, so it sees a picture within
   * a frame rather than waiting out the next keyframe.
   */
  subscribe(listener: (unit: VideoAccessUnit) => void): () => void;
  subscriberCount(): number;
  /** Why the encoder is not running, once something has gone wrong. */
  failure(): string | undefined;
  /** Change the bitrate/sharpness trade. Restarts ffmpeg — see the note below. */
  setTier(tier: VideoTier): void;
  /**
   * Follow the display to a new size.
   *
   * A RESTART, like `setTier`, and for a stronger reason: an H.264 stream's
   * SPS carries the picture dimensions, so a stream that says 1024 wide cannot
   * carry a 1400-wide frame at all. A decoder handed one drops it or renders
   * garbage — and `repeat-headers=1` means the restart puts fresh parameter
   * sets in front of the first key unit, which is exactly what every watcher
   * needs to start decoding the new geometry.
   *
   * Frames captured before the transition are already gone: `stop()` tears
   * down the ffmpeg that produced them, so nothing from the previous
   * generation can reach a subscriber after this returns.
   */
  resize(size: { width: number; height: number }): void;
  tier(): VideoTier;
  /**
   * How many access units this encoder has published, ever.
   *
   * A COUNTER rather than a "has anything happened since you last asked"
   * flag, because ONE encoder serves every watcher: a flag consumed by the
   * first watcher's heartbeat told the second that nothing had been emitted,
   * every time. Each stream remembers the count it last saw and compares.
   */
  emitted(): number;
  dispose(): void;
}

/** NAL unit types this module cares about. */
const NAL_AUD = 9;
const NAL_IDR = 5;

/**
 * How much of the current GOP to keep for a late joiner.
 *
 * A cap in BYTES rather than in units: a GOP is 120 frames by the arguments
 * below, and on a page that is actually moving that can be megabytes. Replaying
 * all of it to a pane that just opened would spend the first second of its
 * connection catching up on motion nobody watched.
 */
const MAX_RING_BYTES = 3 * 1024 * 1024;

/** Per-tier ffmpeg arguments, after the input and before the output. */
export function tierArgs(tier: VideoTier): string[] {
  switch (tier) {
    case "sharp":
      // Text stays readable at the cost of bandwidth: the tier somebody picks
      // when they are reading a page rather than watching one move.
      return ["-crf", "18", "-maxrate", "6M", "-bufsize", "12M"];
    case "saver":
      // Half the width, and a bitrate a poor link can actually carry. Scaled
      // in the encoder rather than by the client so the BYTES go down, which
      // is the entire point of the tier.
      return [
        "-vf",
        "mpdecimate,scale=768:-2",
        "-crf",
        "28",
        "-maxrate",
        "600k",
        "-bufsize",
        "1200k",
      ];
    default:
      return ["-crf", "23", "-maxrate", "2500k", "-bufsize", "5M"];
  }
}

/**
 * The full argument list.
 *
 * Exported so a test can read it rather than a comment describing it — every
 * flag here is load-bearing and several are non-obvious:
 *
 *   `-vf mpdecimate`   drops frames identical to the last, so an idle page
 *                      costs nothing. With `-fps_mode vfr` that means no
 *                      output at all rather than repeated frames, which is
 *                      what makes idle bandwidth ~0 — and why the heartbeat
 *                      has to say `encoderIdle`, or a client would read the
 *                      silence as loss.
 *   `-tune zerolatency` no frame reordering and no lookahead. B-frames would
 *                      buy compression and cost exactly the thing this is for.
 *   `-profile:v baseline` the profile every `VideoDecoder` implementation
 *                      accepts.
 *   `-g 120`           a keyframe every four seconds at 30fps, which bounds
 *                      how stale the ring's replay can be.
 *   `-threads 1`       ONE encoder thread, pinned. `-tune zerolatency` leaves
 *                      x264's thread count at `auto`, which is 1.5x the cores
 *                      — on a 2 vCPU box that is three encoder threads
 *                      competing with Chromium and the desktop for two cores,
 *                      and the thing that starves is the capture loop feeding
 *                      this very encoder. One thread keeps up at 30fps and
 *                      leaves the rest of the box to the agent.
 *   `aud=1`            an access-unit delimiter before each picture. Without
 *                      it there is no reliable byte to split a stream on.
 *   `repeat-headers=1` SPS/PPS in front of every keyframe, so a late joiner
 *                      needs nothing that came before.
 */
export function ffmpegArgs(options: {
  display: string;
  width: number;
  height: number;
  tier: VideoTier;
}): string[] {
  const tier = tierArgs(options.tier);
  // The saver tier brings its own `-vf` (it scales); everything else gets the
  // plain decimator. Two `-vf` flags would silently keep only the last.
  const filters = tier.includes("-vf") ? [] : ["-vf", "mpdecimate"];
  return [
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    "30",
    "-video_size",
    `${options.width}x${options.height}`,
    "-draw_mouse",
    "1",
    "-i",
    options.display,
    ...filters,
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "120",
    "-sc_threshold",
    "0",
    "-x264-params",
    "aud=1:repeat-headers=1",
    // Before the tier args and the output, so a tier that ever grows its own
    // rate-control flags cannot end up on the far side of it.
    "-threads",
    "1",
    ...tier,
    "-f",
    "h264",
    "pipe:1",
  ];
}

/**
 * Split an Annex-B byte stream into access units.
 *
 * Stateful, because ffmpeg's stdout has no relationship to unit boundaries.
 * The split point is the AUD (NAL type 9), which `aud=1` guarantees precedes
 * every picture — so a unit is "from one AUD up to (not including) the next".
 * Nothing is emitted until the NEXT delimiter arrives, because until then the
 * unit might still be growing.
 */
export function createAccessUnitSplitter(): {
  push(chunk: Uint8Array): VideoAccessUnit[];
  /** Emit whatever is buffered, for a stream that ended cleanly. */
  flush(): VideoAccessUnit[];
} {
  let buffer = new Uint8Array(0);

  const emit = (bytes: Uint8Array): VideoAccessUnit => ({
    key: containsIdr(bytes),
    bytes,
  });

  return {
    push(chunk) {
      if (chunk.byteLength > 0) {
        const merged = new Uint8Array(buffer.byteLength + chunk.byteLength);
        merged.set(buffer);
        merged.set(chunk, buffer.byteLength);
        buffer = merged;
      }
      const units: VideoAccessUnit[] = [];
      // The FIRST delimiter is where the stream becomes readable; anything
      // before it is a partial unit from before we attached.
      let start = findDelimiter(buffer, 0);
      if (start < 0) return units;
      for (;;) {
        const next = findDelimiter(buffer, start + 4);
        if (next < 0) break;
        units.push(emit(buffer.slice(start, next)));
        start = next;
      }
      buffer = buffer.slice(start);
      return units;
    },
    flush() {
      if (buffer.byteLength === 0) return [];
      const start = findDelimiter(buffer, 0);
      const units = start >= 0 ? [emit(buffer.slice(start))] : [];
      buffer = new Uint8Array(0);
      return units;
    },
  };
}

/** The offset of the next access-unit delimiter, or -1. */
function findDelimiter(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i + 4 < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    // Both start-code lengths: x264 writes 4-byte codes before parameter sets
    // and the first slice, and 3-byte codes elsewhere.
    if (bytes[i + 2] === 1) {
      if ((bytes[i + 3]! & 0x1f) === NAL_AUD) return i;
      continue;
    }
    if (bytes[i + 2] === 0 && bytes[i + 3] === 1 && i + 4 < bytes.byteLength) {
      if ((bytes[i + 4]! & 0x1f) === NAL_AUD) return i;
    }
  }
  return -1;
}

/** Does this access unit contain an IDR slice? */
export function containsIdr(bytes: Uint8Array): boolean {
  for (let i = 0; i + 3 < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    if (bytes[i + 2] === 1) {
      if ((bytes[i + 3]! & 0x1f) === NAL_IDR) return true;
      continue;
    }
    if (
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1 &&
      i + 4 < bytes.byteLength &&
      (bytes[i + 4]! & 0x1f) === NAL_IDR
    ) {
      return true;
    }
  }
  return false;
}

export function createVideoEncoder(options: VideoEncoderOptions): VideoEncoder {
  const spawnProcess =
    options.spawnProcess ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], {
        stdio: [...spawnOptions.stdio],
      }) as unknown as EncoderProcess);
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const listeners = new Set<(unit: VideoAccessUnit) => void>();
  let tier: VideoTier = options.tier ?? "auto";
  /**
   * The display's size, which MOVES on a responsive session.
   *
   * `let` rather than `options.width`, because `resize` changes it and every
   * later ffmpeg start has to grab the screen that is actually there.
   */
  let width = Math.max(2, Math.round(options.width));
  let height = Math.max(2, Math.round(options.height));
  let child: EncoderProcess | undefined;
  let splitter = createAccessUnitSplitter();
  let failure: string | undefined;
  let disposed = false;
  /** The current GOP, so a late joiner sees a picture without waiting. */
  let ring: VideoAccessUnit[] = [];
  let ringBytes = 0;
  /** Monotonic count of published units — see `emitted()`. */
  let emittedCount = 0;

  const publish = (unit: VideoAccessUnit): void => {
    emittedCount += 1;
    if (unit.key) {
      // A new GOP: everything before it is unreachable from here anyway.
      ring = [unit];
      ringBytes = unit.bytes.byteLength;
    } else if (ring.length > 0) {
      ring.push(unit);
      ringBytes += unit.bytes.byteLength;
      while (ring.length > 1 && ringBytes > MAX_RING_BYTES) {
        // Never the keyframe: without it the rest of the ring decodes to
        // nothing, and replaying it to a late joiner would be worse than
        // replaying nothing at all.
        const dropped = ring.splice(1, 1)[0];
        ringBytes -= dropped?.bytes.byteLength ?? 0;
      }
    }
    for (const listener of listeners) {
      try {
        listener(unit);
      } catch {
        // One bad subscriber must not take the stream down for the others.
      }
    }
  };

  const stop = (): void => {
    const running = child;
    child = undefined;
    ring = [];
    ringBytes = 0;
    splitter = createAccessUnitSplitter();
    if (!running) return;
    try {
      running.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  };

  const start = (): void => {
    if (child || disposed) return;
    failure = undefined;
    let started: EncoderProcess;
    try {
      started = spawnProcess(
        ffmpegPath,
        ffmpegArgs({
          display: options.display,
          // The CURRENT geometry, not the one this encoder was built with: a
          // `followPane` session moves the display, and an ffmpeg restarted
          // after that must grab the screen that is actually there. `x11grab`
          // with a `-video_size` larger than the screen fails outright; one
          // smaller silently captures a corner.
          width,
          height,
          tier,
        }),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // No ffmpeg on this image is a SUPPORTED state, not a failure of the
      // daemon: the watcher falls back to JPEG.
      failure = error instanceof Error ? error.message : String(error);
      return;
    }
    child = started;
    started.on("error", (error) => {
      if (started !== child) return;
      failure = error.message;
      stop();
    });
    started.on("exit", (code) => {
      if (started !== child) return;
      // A clean exit is still an end: nothing else will produce a picture.
      failure = `ffmpeg exited (${code ?? "signal"})`;
      stop();
    });
    started.stdout.on("data", (chunk: Buffer) => {
      if (started !== child) return;
      for (const unit of splitter.push(new Uint8Array(chunk))) publish(unit);
    });
    // Drained rather than ignored: an unread pipe fills and blocks the encoder.
    started.stderr.on("data", () => {});
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      // The current GOP first, so this subscriber has a picture immediately
      // rather than after up to four seconds of waiting for the next keyframe.
      for (const unit of ring) {
        try {
          listener(unit);
        } catch {
          // Same rule as `publish`.
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    subscriberCount: () => listeners.size,
    failure: () => failure,
    tier: () => tier,
    resize(size) {
      const nextWidth = Math.max(2, Math.round(size.width));
      const nextHeight = Math.max(2, Math.round(size.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      if (!child) return;
      // See the interface note: the SPS carries the dimensions, so this is a
      // restart rather than a reconfiguration, and the restart is what mints
      // the parameter sets and the keyframe the new geometry needs.
      stop();
      start();
    },
    setTier(next) {
      if (next === tier) return;
      tier = next;
      if (!child) return;
      // RESTARTED, not reconfigured. x264 takes its rate control at start, and
      // the restart is what produces the fresh IDR every subscriber needs to
      // decode the new stream — a mid-GOP switch would hand them deltas
      // against a picture encoded under the old settings.
      stop();
      start();
    },
    emitted() {
      return emittedCount;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      stop();
    },
  };
}

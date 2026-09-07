/**
 * The display encoder.
 *
 * Everything here runs without ffmpeg and without an X server: the process is
 * injected, and what is under test is the part that would be wrong in a way
 * nobody notices — where an access unit begins, which ones a decoder can start
 * from, what a late joiner is replayed, and what happens when the encoder is
 * simply not there.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  containsIdr,
  createAccessUnitSplitter,
  createVideoEncoder,
  ffmpegArgs,
  tierArgs,
  type VideoAccessUnit,
} from "../video-encoder";

/** An Annex-B access unit: a delimiter, then the NAL types given. */
function au(...nalTypes: number[]): Uint8Array {
  const bytes: number[] = [0, 0, 0, 1, 9, 0x10];
  for (const type of nalTypes) bytes.push(0, 0, 1, type, 0xab, 0xcd);
  return new Uint8Array(bytes);
}

const KEY = () => au(7, 8, 5); // SPS, PPS, IDR
const DELTA = () => au(1); // a non-IDR slice

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A stand-in for ffmpeg. */
function fakeFfmpeg() {
  const spawned: Array<{ command: string; args: readonly string[] }> = [];
  const processes: Array<{
    stdout: EventEmitter;
    stderr: EventEmitter;
    events: EventEmitter;
    killed: boolean;
  }> = [];
  const spawnProcess = (command: string, args: readonly string[]) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const events = new EventEmitter();
    const entry = { stdout, stderr, events, killed: false };
    spawned.push({ command, args });
    processes.push(entry);
    return {
      stdout: { on: (e: string, fn: never) => stdout.on(e, fn) },
      stderr: { on: (e: string, fn: never) => stderr.on(e, fn) },
      on: (e: string, fn: never) => events.on(e, fn),
      kill: () => {
        entry.killed = true;
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
  const ffmpeg = fakeFfmpeg();
  const encoder = createVideoEncoder({
    display: ":0",
    width: 1024,
    height: 768,
    spawnProcess: ffmpeg.spawnProcess,
    ...over,
  });
  return { encoder, ffmpeg };
}

describe("the ffmpeg arguments", () => {
  const args = ffmpegArgs({
    display: ":0",
    width: 1024,
    height: 768,
    tier: "auto",
  });

  it("grabs the display, not a page", () => {
    // The screencast can never show a native file chooser, a print dialog or a
    // permission prompt — every moment a person actually needs to take over.
    expect(args).toContain("x11grab");
    expect(args.join(" ")).toContain("-video_size 1024x768");
  });

  it("emits an access-unit delimiter and repeats the headers", () => {
    // Without the delimiter there is no reliable byte to split a stream on;
    // without the repeated headers a late joiner needs bytes it never saw.
    expect(args.join(" ")).toContain("aud=1:repeat-headers=1");
  });

  it("drops identical frames, so an idle page costs nothing", () => {
    expect(args.join(" ")).toContain("mpdecimate");
    // With variable frame rate that means NO output at all rather than
    // repeated frames — which is why the heartbeat has to say `encoderIdle`.
    expect(args.join(" ")).toContain("-fps_mode vfr");
  });

  it("asks for no reordering and a profile every decoder accepts", () => {
    expect(args.join(" ")).toContain("-tune zerolatency");
    expect(args.join(" ")).toContain("-profile:v baseline");
  });

  it("never passes two video filters, which would keep only the last", () => {
    const saver = ffmpegArgs({
      display: ":0",
      width: 1024,
      height: 768,
      tier: "saver",
    });
    expect(saver.filter((arg) => arg === "-vf")).toHaveLength(1);
    expect(saver.join(" ")).toContain("scale=768:-2");
    expect(tierArgs("sharp").join(" ")).toContain("-crf 18");
  });
});

describe("splitting the stream into access units", () => {
  it("emits a unit only once the NEXT delimiter proves it is complete", () => {
    const splitter = createAccessUnitSplitter();
    expect(splitter.push(KEY())).toHaveLength(0);
    const units = splitter.push(DELTA());
    expect(units).toHaveLength(1);
    expect(units[0]!.key).toBe(true);
  });

  it("reassembles a unit split across chunks", () => {
    // ffmpeg's stdout has no relationship to unit boundaries.
    const splitter = createAccessUnitSplitter();
    const stream = concat(KEY(), DELTA(), DELTA());
    const units: VideoAccessUnit[] = [];
    for (let at = 0; at < stream.byteLength; at += 5) {
      units.push(...splitter.push(stream.slice(at, at + 5)));
    }
    expect(units.map((unit) => unit.key)).toEqual([true, false]);
    expect(splitter.flush()).toHaveLength(1);
  });

  it("discards a partial unit from before it attached", () => {
    // Bytes before the first delimiter belong to a picture we never saw the
    // start of; handing them to a decoder desynchronises it.
    const splitter = createAccessUnitSplitter();
    const units = splitter.push(
      concat(new Uint8Array([0, 0, 1, 1, 0xff, 0xff]), KEY(), DELTA()),
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.key).toBe(true);
  });

  it("tells a decodable unit from one that depends on history", () => {
    expect(containsIdr(KEY())).toBe(true);
    expect(containsIdr(DELTA())).toBe(false);
  });
});

describe("the encoder's lifecycle", () => {
  it("starts on the first watcher and stops after the last", () => {
    const { encoder, ffmpeg } = build();
    expect(ffmpeg.spawned).toHaveLength(0);
    const first = encoder.subscribe(() => {});
    const second = encoder.subscribe(() => {});
    expect(ffmpeg.spawned).toHaveLength(1);
    first();
    expect(ffmpeg.latest().killed).toBe(false);
    second();
    // An encoder running for nobody is CPU the agent is also trying to use.
    expect(ffmpeg.latest().killed).toBe(true);
  });

  it("replays the current GOP to a late joiner", () => {
    // Otherwise a pane that just opened waits out up to four seconds for the
    // next keyframe with nothing on screen.
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    ffmpeg.latest().stdout.emit("data", Buffer.from(concat(KEY(), DELTA())));
    ffmpeg.latest().stdout.emit("data", Buffer.from(DELTA()));

    const late: VideoAccessUnit[] = [];
    encoder.subscribe((unit) => late.push(unit));
    expect(late.map((unit) => unit.key)).toEqual([true, false]);
  });

  it("starts a late joiner's replay from a keyframe, never mid-GOP", () => {
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    // Deltas with no keyframe before them: nothing to replay, because nothing
    // in them decodes on its own.
    ffmpeg.latest().stdout.emit("data", Buffer.from(concat(DELTA(), DELTA())));
    const late: VideoAccessUnit[] = [];
    encoder.subscribe((unit) => late.push(unit));
    expect(late).toHaveLength(0);
  });

  it("reports a spawn that failed rather than throwing", () => {
    // No ffmpeg on the image is a SUPPORTED state: the watcher falls back to
    // JPEG, exactly as a client with no VideoDecoder does.
    const encoder = createVideoEncoder({
      display: ":0",
      width: 1024,
      height: 768,
      spawnProcess: (() => {
        throw new Error("spawn ffmpeg ENOENT");
      }) as never,
    });
    expect(() => encoder.subscribe(() => {})).not.toThrow();
    expect(encoder.failure()).toContain("ENOENT");
  });

  it("reports an encoder that died mid-stream", () => {
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    ffmpeg.latest().events.emit("exit", 1);
    expect(encoder.failure()).toContain("exited");
  });

  it("restarts on a tier change, so every watcher gets a fresh keyframe", () => {
    // x264 takes its rate control at start; a mid-GOP switch would hand
    // watchers deltas against a picture encoded under the old settings.
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    expect(ffmpeg.spawned).toHaveLength(1);
    encoder.setTier("sharp");
    expect(ffmpeg.spawned).toHaveLength(2);
    expect(ffmpeg.spawned[1]!.args.join(" ")).toContain("-crf 18");
    // The same tier twice is not a restart.
    encoder.setTier("sharp");
    expect(ffmpeg.spawned).toHaveLength(2);
  });

  it("counts what it has published, so every watcher can tell idle from lost", () => {
    // `mpdecimate` means an idle page produces no frames at all; a client that
    // read that silence as loss would step the quality down on a page that is
    // simply not moving.
    //
    // A COUNTER rather than a consumed flag, because ONE encoder serves every
    // watcher: a flag taken by the first watcher's heartbeat told the second
    // that nothing had been emitted, every single time.
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    const start = encoder.emitted();
    ffmpeg.latest().stdout.emit("data", Buffer.from(concat(KEY(), DELTA())));
    const after = encoder.emitted();
    expect(after).toBeGreaterThan(start);
    // Two readers, each comparing against what IT last saw, both see the same
    // two units — which is the whole point of not consuming.
    expect(encoder.emitted()).toBe(after);
  });

  it("survives a subscriber that throws", () => {
    const { encoder, ffmpeg } = build();
    const seen: VideoAccessUnit[] = [];
    encoder.subscribe(() => {
      throw new Error("bad watcher");
    });
    encoder.subscribe((unit) => seen.push(unit));
    ffmpeg.latest().stdout.emit("data", Buffer.from(concat(KEY(), DELTA())));
    expect(seen).toHaveLength(1);
  });

  it("stops everything on dispose", () => {
    const { encoder, ffmpeg } = build();
    encoder.subscribe(() => {});
    encoder.dispose();
    expect(ffmpeg.latest().killed).toBe(true);
    expect(encoder.subscriberCount()).toBe(0);
  });
});

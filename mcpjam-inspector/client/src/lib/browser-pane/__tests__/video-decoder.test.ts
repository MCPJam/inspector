/**
 * H.264 in the pane.
 *
 * The conversion is the reason this file exists: ffmpeg writes Annex-B, Chrome
 * takes it directly, and Safari's support for the `annexb` description format
 * is unverified — a failure mode whose symptom is a browser that silently shows
 * nothing, on somebody else's machine. Converting to AVCC once, here, is what
 * removes the per-browser branch, so the conversion has to be exactly right.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  annexBToAvcc,
  buildAvccDescription,
  codecStringFor,
  createPaneVideoDecoder,
  splitNalUnits,
  videoDecodeSupported,
} from "../video-decoder";

/**
 * jsdom has no WebCodecs, so the chunk type the decoder constructs does not
 * exist. Stubbed rather than avoided: constructing it IS the behaviour under
 * test — an implementation that skipped it would pass against a fake decoder
 * and fail in every browser.
 */
class FakeEncodedVideoChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly byteLength: number;
  constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.byteLength = init.data.byteLength;
  }
}

beforeEach(() => {
  vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);
});

/** SPS with recognisable profile bytes, PPS, IDR. */
const SPS = new Uint8Array([0x67, 0x42, 0xe0, 0x1f, 0xaa]);
const PPS = new Uint8Array([0x68, 0xce, 0x3c]);
const IDR = new Uint8Array([0x65, 0x11, 0x22]);
const SLICE = new Uint8Array([0x41, 0x33]);
const AUD = new Uint8Array([0x09, 0x10]);

function annexB(...units: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const unit of units) {
    out.push(0, 0, 0, 1, ...unit);
  }
  return new Uint8Array(out);
}

describe("splitting Annex-B", () => {
  it("finds every unit and drops the start codes", () => {
    const units = splitNalUnits(annexB(AUD, SPS, PPS, IDR));
    expect(units).toHaveLength(4);
    expect(units[1]).toEqual(SPS);
    expect(units[3]).toEqual(IDR);
  });

  it("handles three- and four-byte start codes in one buffer", () => {
    // x264 writes four-byte codes before the parameter sets and three-byte
    // ones elsewhere; a splitter that knew only one would fuse units together.
    const bytes = new Uint8Array([
      0, 0, 0, 1, ...SPS,
      0, 0, 1, ...PPS,
      0, 0, 0, 1, ...IDR,
    ]);
    const units = splitNalUnits(bytes);
    expect(units).toEqual([SPS, PPS, IDR]);
  });
});

describe("the avcC description", () => {
  it("carries the profile bytes straight out of the SPS", () => {
    const description = buildAvccDescription([AUD, SPS, PPS, IDR])!;
    expect(description[0]).toBe(1); // configurationVersion
    expect([description[1], description[2], description[3]]).toEqual([
      0x42, 0xe0, 0x1f,
    ]);
    // lengthSizeMinusOne = 3, i.e. the 4-byte lengths `annexBToAvcc` writes.
    expect(description[4]! & 0x03).toBe(3);
    // And the parameter sets themselves, length-prefixed: a count byte, then
    // a big-endian length, then the SPS.
    expect(description[5]).toBe(0xe1);
    expect((description[6]! << 8) | description[7]!).toBe(SPS.byteLength);
    expect(description.slice(8, 8 + SPS.byteLength)).toEqual(SPS);
  });

  it("is absent for a unit that carries no parameter sets", () => {
    // Which is every delta unit — and is why a decoder can only be configured
    // from a key one.
    expect(buildAvccDescription([AUD, SLICE])).toBeUndefined();
  });

  it("reads the codec string rather than assuming one", () => {
    // A level is a function of resolution, and the DPR work exists precisely
    // to change resolution. Assuming `avc1.42E01F` would let the configuration
    // silently disagree with the stream.
    expect(codecStringFor([SPS])).toBe("avc1.42E01F");
    expect(codecStringFor([new Uint8Array([0x67, 0x4d, 0x40, 0x28])])).toBe(
      "avc1.4D4028",
    );
    expect(codecStringFor([])).toBe("avc1.42E01F");
  });
});

describe("Annex-B to AVCC", () => {
  it("replaces start codes with four-byte lengths", () => {
    const out = annexBToAvcc([IDR]);
    expect(Array.from(out.slice(0, 4))).toEqual([0, 0, 0, IDR.byteLength]);
    expect(out.slice(4)).toEqual(IDR);
  });

  it("drops the parameter sets and the delimiter", () => {
    // They belong in the `description`; a decoder configured with an avcC and
    // then handed in-band SPS/PPS is being told the same thing twice, and some
    // implementations treat the second telling as an error.
    const out = annexBToAvcc([AUD, SPS, PPS, IDR]);
    expect(out.byteLength).toBe(4 + IDR.byteLength);
  });
});

/** A `VideoDecoder` double that records what it was asked to do. */
function fakeDecoder() {
  const state = {
    configured: undefined as VideoDecoderConfig | undefined,
    chunks: [] as Array<{ type: string; timestamp: number; size: number }>,
    closed: false,
    output: undefined as ((frame: VideoFrame) => void) | undefined,
    error: undefined as ((error: Error) => void) | undefined,
    decodeThrows: false,
  };
  const create = (init: VideoDecoderInit) => {
    state.output = init.output;
    state.error = init.error;
    return {
      configure: (config: VideoDecoderConfig) => {
        state.configured = config;
      },
      decode: (chunk: EncodedVideoChunk) => {
        if (state.decodeThrows) throw new Error("decode failed");
        state.chunks.push({
          type: chunk.type,
          timestamp: chunk.timestamp,
          size: chunk.byteLength,
        });
      },
      close: () => {
        state.closed = true;
      },
    } as unknown as VideoDecoder;
  };
  return { state, create };
}

describe("the pane's decoder", () => {
  it("waits for a key unit before configuring", () => {
    // A delta decodes against a picture that does not exist yet, and the
    // parameter sets it would need ride in front of a key unit.
    const fake = fakeDecoder();
    const decoder = createPaneVideoDecoder({
      onFrame: () => {},
      onGiveUp: () => {},
      createDecoder: fake.create,
    });
    decoder.push({ key: false, au: annexB(AUD, SLICE), seq: 1 });
    expect(fake.state.configured).toBeUndefined();
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 2 });
    expect(fake.state.configured).toMatchObject({
      codec: "avc1.42E01F",
      optimizeForLatency: true,
    });
    expect(fake.state.configured?.description).toBeInstanceOf(Uint8Array);
  });

  it("labels each chunk and stamps it from the wire's own sequence", () => {
    const fake = fakeDecoder();
    const decoder = createPaneVideoDecoder({
      onFrame: () => {},
      onGiveUp: () => {},
      createDecoder: fake.create,
    });
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 3 });
    decoder.push({ key: false, au: annexB(AUD, SLICE), seq: 4 });
    expect(fake.state.chunks.map((chunk) => chunk.type)).toEqual([
      "key",
      "delta",
    ]);
    expect(fake.state.chunks[0]!.timestamp).toBe(3_000);
  });

  it("closes every frame it hands out", () => {
    // A `VideoFrame` holds a decoded surface the garbage collector cannot see
    // the cost of; a decoder at 30fps that leaked them exhausts the pool
    // within a second and stalls.
    const fake = fakeDecoder();
    let closed = false;
    const decoder = createPaneVideoDecoder({
      onFrame: () => {},
      onGiveUp: () => {},
      createDecoder: fake.create,
    });
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 1 });
    fake.state.output?.({
      close: () => {
        closed = true;
      },
    } as unknown as VideoFrame);
    expect(closed).toBe(true);
  });

  it("survives a few errors and then gives up honestly", () => {
    // One corrupt access unit is survivable — the next keyframe repairs it. A
    // decoder that keeps erroring is showing a person a frozen picture while
    // it tries, which is worse than an honest fallback.
    const fake = fakeDecoder();
    const reasons: string[] = [];
    const decoder = createPaneVideoDecoder({
      onFrame: () => {},
      onGiveUp: (reason) => reasons.push(reason),
      createDecoder: fake.create,
    });
    for (let i = 0; i < 3; i += 1) {
      decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: i });
      fake.state.error?.(new Error("bad frame"));
    }
    expect(reasons).toEqual([]);
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 9 });
    fake.state.error?.(new Error("bad frame"));
    expect(reasons).toHaveLength(1);
    // And it stops: nothing more reaches the decoder after it gave up.
    const before = fake.state.chunks.length;
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 10 });
    expect(fake.state.chunks).toHaveLength(before);
  });

  it("treats a throwing decode as an error rather than crashing the pane", () => {
    const fake = fakeDecoder();
    const decoder = createPaneVideoDecoder({
      onFrame: () => {},
      onGiveUp: () => {},
      createDecoder: fake.create,
    });
    decoder.push({ key: true, au: annexB(AUD, SPS, PPS, IDR), seq: 1 });
    fake.state.decodeThrows = true;
    expect(() =>
      decoder.push({ key: false, au: annexB(AUD, SLICE), seq: 2 }),
    ).not.toThrow();
  });

  it("knows when this browser cannot decode video at all", () => {
    vi.stubGlobal("VideoDecoder", undefined);
    expect(videoDecodeSupported()).toBe(false);
    vi.stubGlobal("VideoDecoder", function VideoDecoderStub() {});
    expect(videoDecodeSupported()).toBe(true);
  });
});

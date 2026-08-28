import { describe, expect, it } from "vitest";
import {
  describeTruncatedRpcPayload,
  isTruncatedRpcPayload,
  measureString,
  probeSerializedSize,
  truncateRpcPayload,
} from "../rpc-log-truncation";

/** What the value really costs on the wire, measured the way a consumer does. */
function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * An object with `count` enumerable getters that record every read. The probe
 * reads a value only when it enqueues it, so `touched` is exactly how far into
 * the frame the walk got.
 */
function countingWideObject(count: number): {
  value: Record<string, unknown>;
  touched: () => number;
} {
  let touched = 0;
  const value: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    Object.defineProperty(value, `k${i}`, {
      enumerable: true,
      get() {
        touched++;
        return i;
      },
    });
  }
  return { value, touched: () => touched };
}

// Every budget in this module is charged in serialized bytes. `value.length`
// used to stand in for that and counts UTF-16 code units, which is a different
// number for everything but ASCII.
describe("measureString", () => {
  it("counts exactly what JSON.stringify would write", () => {
    // `.length` reads these as 3, 1, 1, 2 and 1 respectively.
    expect(measureString("\u65e5\u672c\u8a9e", Infinity)).toEqual({
      utf8: 9,
      json: 11,
    });
    expect(measureString("\u0001", Infinity)).toEqual({ utf8: 1, json: 8 });
    expect(measureString('"', Infinity)).toEqual({ utf8: 1, json: 4 });
    // An astral code point is one character over two UTF-16 units...
    expect(measureString("\u{1F600}", Infinity)).toEqual({ utf8: 4, json: 6 });
    // ...and half of one encodes as the replacement character but serializes
    // as a six-character escape.
    expect(measureString("\ud800", Infinity)).toEqual({ utf8: 3, json: 8 });
  });

  it("leaves both counts over the budget when it stops early", () => {
    // The early exit is on `utf8`, the smaller of the two, so a caller
    // comparing EITHER count against the same budget still gets "over".
    const measured = measureString("\u65e5".repeat(100_000), 1024);

    expect(measured.utf8).toBeGreaterThan(1024);
    expect(measured.json).toBeGreaterThan(1024);
  });
});

describe("probeSerializedSize", () => {
  it("stops walking a very wide object at the budget instead of enqueuing every key", () => {
    const { value, touched } = countingWideObject(20_000);

    expect(probeSerializedSize(value, 1024).exceeded).toBe(true);
    // ~9 bytes of key overhead each, so the budget falls a couple of hundred
    // keys in. Enqueuing all 20,000 first is the allocation this walk exists
    // to avoid.
    expect(touched()).toBeLessThan(1000);
  });

  it("reports a large sparse array as oversized without walking its holes", () => {
    // `for...of` yields one `undefined` per hole, so a naive walk would push
    // ten million entries onto the stack before the first budget check.
    const sparse = new Array(10_000_000);

    const result = probeSerializedSize(sparse, 256 * 1024);

    expect(result.exceeded).toBe(true);
  });

  it("sizes a small frame without reporting it oversized", () => {
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    const result = probeSerializedSize(frame, 1024);

    expect(result.exceeded).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
  });

  // Regression: `.length` read this frame as ~100 KB and let it through a
  // 256 KB cap that JSON.stringify blows by 44 KB.
  it("sizes a CJK payload by its serialized bytes, not its UTF-16 length", () => {
    const frame = { a: "\u65e5".repeat(100_000) };
    expect(serializedBytes(frame)).toBeGreaterThan(256 * 1024);

    expect(probeSerializedSize(frame, 256 * 1024).exceeded).toBe(true);
  });

  // Control characters are the worse direction: JSON writes six characters for
  // each one, so `.length` undercounted this frame by 6x.
  it("counts a control character as the escape JSON writes for it", () => {
    const frame = { a: "\u0001".repeat(100_000) };
    expect(serializedBytes(frame)).toBeGreaterThan(256 * 1024);

    expect(probeSerializedSize(frame, 256 * 1024).exceeded).toBe(true);
  });
});

describe("truncateRpcPayload", () => {
  it("keeps a null id rather than claiming a body was dropped there", () => {
    // JSON-RPC uses `id: null` for an error response to a frame that never
    // parsed. `typeof null === "object"`, so it used to come back as a marker.
    const truncated = truncateRpcPayload(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "x".repeat(400) },
      },
      256,
    );

    expect(truncated).toEqual({
      jsonrpc: "2.0",
      id: null,
      // The walk descends, so the error CODE survives too — the single most
      // useful field on a frame whose body could not be kept.
      error: { code: -32700, message: { _truncated: true, bytes: 400 } },
      _truncated: true,
      limitBytes: 256,
    });
  });

  it("descends into a dropped field instead of collapsing it, and names the size", () => {
    const truncated = truncateRpcPayload(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        streaming: false,
        params: { data: "x".repeat(5000) },
      },
      1024,
    );

    // `params` used to become a bare `{_truncated: true}`, which told a reader
    // nothing about what had been there. Its shape now survives, and the string
    // that could not fit reports its own length.
    expect(truncated).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      streaming: false,
      params: { data: { _truncated: true, bytes: 5000 } },
      _truncated: true,
      limitBytes: 1024,
    });
  });

  it("keeps a head of an oversized string when the budget has room for one", () => {
    const truncated = truncateRpcPayload(
      { jsonrpc: "2.0", id: 8, result: { content: [{ type: "text", text: "y".repeat(1_048_576) }] } },
      1024 * 1024,
    );

    const text = (truncated as any).result.content[0].text;
    expect(text.bytes).toBe(1_048_576);
    expect(text.head).toHaveLength(8 * 1024);
    expect(text.head).toBe("y".repeat(8 * 1024));
    // Sibling scalars inside the same content block are untouched — the reader
    // can still tell WHAT kind of block lost its body.
    expect((truncated as any).result.content[0].type).toBe("text");
  });

  it("keeps a frame's `_meta` — 150 bytes that the depth-one collapse always threw away", () => {
    const truncated = truncateRpcPayload(
      {
        jsonrpc: "2.0",
        id: 9,
        result: {
          content: [{ type: "text", text: "z".repeat(2_000_000) }],
          _meta: { tool: "big_text", actualBytes: 2_000_000, fnv: "4db183ec" },
        },
      },
      1024 * 1024,
    );

    expect((truncated as any).result._meta).toEqual({
      tool: "big_text",
      actualBytes: 2_000_000,
      fnv: "4db183ec",
    });
  });

  it("never returns more than the limit, whatever the frame looks like", () => {
    for (const limit of [512, 16 * 1024, 1024 * 1024]) {
      const truncated = truncateRpcPayload(
        {
          jsonrpc: "2.0",
          id: 10,
          result: {
            a: "x".repeat(5_000_000),
            b: "y".repeat(5_000_000),
            c: Array.from({ length: 200 }, () => "z".repeat(50_000)),
          },
        },
        limit,
      );
      expect(probeSerializedSize(truncated, limit).exceeded).toBe(false);
    }
  });

  // The ceiling is a PROMISE, not an approximation: `harness-rpc-log-sink`
  // sizes a Convex document against it. Measured in UTF-16 units a 16 KB limit
  // came back with 24 KB of CJK on the wire, and the document limit is the next
  // ceiling up.
  it("holds its limit in real bytes for a frame that is not ASCII", () => {
    for (const limit of [512, 16 * 1024, 1024 * 1024]) {
      const truncated = truncateRpcPayload(
        {
          jsonrpc: "2.0",
          id: 12,
          result: {
            text: "\u65e5".repeat(500_000),
            control: "\u0001".repeat(50_000),
          },
        },
        limit,
      );

      expect(serializedBytes(truncated)).toBeLessThanOrEqual(limit);
    }
  });

  // Regression: the marker was spread over the preserved envelope, which only
  // overwrites the keys the marker HAS — and it carries neither `head` nor
  // `reason` on a frame-level truncation. A frame supplying its own read back
  // as the marker's account of what it dropped.
  it("never lets a frame's own field supply the marker's truncation metadata", () => {
    const truncated = truncateRpcPayload(
      {
        jsonrpc: "2.0",
        id: 13,
        head: "ok",
        bytes: 7,
        reason: "not a truncation",
        result: { data: "x".repeat(5_000_000) },
      },
      1024,
    );

    expect(truncated.head).toBeUndefined();
    expect(truncated.bytes).toBeUndefined();
    expect(truncated.reason).toBeUndefined();
    expect(truncated.limitBytes).toBe(1024);
    // The notice used to read "Payload not recorded: not a truncation." — the
    // frame describing itself.
    expect(describeTruncatedRpcPayload(truncated)).toBe(
      "Payload not recorded \u2014 over the 1 KB log limit.",
    );
    // Everything that is not the marker's to own is still there.
    expect(truncated.jsonrpc).toBe("2.0");
    expect(truncated.id).toBe(13);
    expect(truncated.result).toEqual({
      data: { _truncated: true, bytes: 5_000_000 },
    });
  });

  it("terminates on a cyclic frame instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { jsonrpc: "2.0", id: 11 };
    cyclic.self = cyclic;

    const truncated = truncateRpcPayload(cyclic, 1024 * 1024);

    expect(truncated._truncated).toBe(true);
    expect(truncated.id).toBe(11);
  });

  it("returns a bare marker for a frame too wide for the envelope to fit", () => {
    const { value, touched } = countingWideObject(20_000);

    const truncated = truncateRpcPayload(value, 1024);

    // The envelope would have been one entry per key — still over the limit,
    // and built in full before being rejected.
    expect(truncated).toEqual({ _truncated: true, limitBytes: 1024 });
    expect(touched()).toBeLessThan(1000);
  });
});

// The Logs panel renders a one-line notice on any row whose payload carries the
// marker, then renders whatever envelope survived. Both halves are driven by
// these two functions, and both have to hold for payloads no producer emits.
describe("the truncation notice the Logs panel renders", () => {
  it("describes a truncated payload with its limit and, when known, its size", () => {
    expect(
      describeTruncatedRpcPayload({ _truncated: true, limitBytes: 16 * 1024 }),
    ).toBe("Payload not recorded — over the 16 KB log limit.");
    expect(
      describeTruncatedRpcPayload({
        _truncated: true,
        limitBytes: 256 * 1024,
        bytes: 2 * 1024 * 1024,
      }),
    ).toBe("Payload not recorded — over the 256 KB log limit. It was 2.0 MB.");
    expect(
      describeTruncatedRpcPayload({
        _truncated: true,
        reason: "unserializable",
      }),
    ).toBe("Payload not recorded: unserializable.");
    // No limit and no size still reads as a sentence, not as "undefined".
    expect(describeTruncatedRpcPayload({ _truncated: true })).toBe(
      "Payload not recorded — over the log size limit.",
    );
  });

  it("says TRUNCATED, not 'not recorded', once a head survived", () => {
    // The two words carry different information. A reader looking at the first
    // 8 KB has to know the rest exists somewhere, and needs a size to compare
    // against what the server actually sent; a reader looking at nothing needs
    // to know the row never had a body at all.
    expect(
      describeTruncatedRpcPayload({
        _truncated: true,
        limitBytes: 1024 * 1024,
        bytes: 2 * 1024 * 1024,
        head: "x".repeat(8 * 1024),
      }),
    ).toBe(
      "Payload truncated — over the 1.0 MB log limit. It was 2.0 MB. " +
        "Showing the first 8 KB.",
    );
  });

  it("reports the head in the same unit as the size beside it", () => {
    // 4096 CJK characters are 12 KB on the wire. Reported as `head.length` the
    // sentence read "the first 4 KB" next to a size in bytes, and the two
    // numbers invited exactly the ratio nobody should compute from them.
    expect(
      describeTruncatedRpcPayload({
        _truncated: true,
        limitBytes: 1024 * 1024,
        bytes: 3 * 1024 * 1024,
        head: "\u65e5".repeat(4 * 1024),
      }),
    ).toBe(
      "Payload truncated \u2014 over the 1.0 MB log limit. It was 3.0 MB. " +
        "Showing the first 12 KB.",
    );
  });

  it("claims no notice for payloads that were never truncated", () => {
    expect(isTruncatedRpcPayload({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isTruncatedRpcPayload(null)).toBe(false);
    expect(isTruncatedRpcPayload(undefined)).toBe(false);
    expect(isTruncatedRpcPayload({})).toBe(false);
    expect(isTruncatedRpcPayload("_truncated")).toBe(false);
    // A frame that happens to carry the key with another value is not a marker.
    expect(isTruncatedRpcPayload({ _truncated: "yes" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  describeTruncatedRpcPayload,
  isTruncatedRpcPayload,
  probeSerializedSize,
  truncateRpcPayload,
} from "../rpc-log-truncation";

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
      error: { _truncated: true },
      _truncated: true,
      limitBytes: 256,
    });
  });

  it("preserves short scalars and replaces long values with a nested marker", () => {
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

    expect(truncated).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      streaming: false,
      params: { _truncated: true },
      _truncated: true,
      limitBytes: 1024,
    });
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

import { describe, expect, it } from "vitest";
import {
  BAGGAGE_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from "@modelcontextprotocol/client";
import {
  BAGGAGE_META_KEY as LOCAL_BAGGAGE_META_KEY,
  TRACEPARENT_META_KEY as LOCAL_TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY as LOCAL_TRACESTATE_META_KEY,
  extractTraceContext,
  isValidBaggage,
  isValidTraceparent,
  isValidTracestate,
  parseTraceparent,
  sanitizeTraceContext,
  traceContextToMeta,
} from "../src/mcp-client-manager/trace-context.js";

// Non-normative example from the 2026-07-28 spec's `_meta` section.
const SPEC_TRACEPARENT =
  "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";

describe("trace-context reserved key names", () => {
  // The names are spelled locally so the browser entry does not pull the
  // client package's runtime graph. This is the parity check that keeps the
  // local spelling honest.
  it("match the upstream client constants", () => {
    expect(LOCAL_TRACEPARENT_META_KEY).toBe(TRACEPARENT_META_KEY);
    expect(LOCAL_TRACESTATE_META_KEY).toBe(TRACESTATE_META_KEY);
    expect(LOCAL_BAGGAGE_META_KEY).toBe(BAGGAGE_META_KEY);
  });

  it("are NOT under the io.modelcontextprotocol/ prefix", () => {
    for (const key of [
      LOCAL_TRACEPARENT_META_KEY,
      LOCAL_TRACESTATE_META_KEY,
      LOCAL_BAGGAGE_META_KEY,
    ]) {
      expect(key).not.toContain("/");
    }
  });
});

describe("parseTraceparent", () => {
  it("parses the spec's example", () => {
    expect(parseTraceparent(SPEC_TRACEPARENT)).toEqual({
      version: "00",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "00f067aa0ba902b7",
      flags: "01",
      sampled: true,
    });
  });

  it("reads the sampled bit off trace-flags", () => {
    expect(parseTraceparent(SPEC_TRACEPARENT.replace(/-01$/, "-00"))?.sampled)
      .toBe(false);
    expect(parseTraceparent(SPEC_TRACEPARENT.replace(/-01$/, "-03"))?.sampled)
      .toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["missing a field", "00-0af7651916cd43dd8448eb211c80319c-01"],
    ["short trace id", "00-0af7651916cd43dd-00f067aa0ba902b7-01"],
    ["short span id", "00-0af7651916cd43dd8448eb211c80319c-00f067aa-01"],
    ["uppercase hex", SPEC_TRACEPARENT.toUpperCase()],
    ["non-hex", "00-0af7651916cd43dd8448eb211c8031zz-00f067aa0ba902b7-01"],
    ["trailing junk", `${SPEC_TRACEPARENT}-extra`],
    ["leading space", ` ${SPEC_TRACEPARENT}`],
    ["forbidden version ff", SPEC_TRACEPARENT.replace(/^00/, "ff")],
    ["unknown future version", SPEC_TRACEPARENT.replace(/^00/, "01")],
    ["all-zero trace id", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`],
    [
      "all-zero span id",
      `00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`,
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseTraceparent(value as string | undefined)).toBeUndefined();
    expect(isValidTraceparent(value as string | undefined)).toBe(false);
  });
});

describe("isValidTracestate", () => {
  it("accepts single and multi-member lists", () => {
    expect(isValidTracestate("rojo=00f067aa0ba902b7")).toBe(true);
    expect(isValidTracestate("rojo=00f067aa0ba902b7,congo=t61rcWkgMzE")).toBe(
      true,
    );
  });

  it("accepts the tenant@vendor key form and surrounding whitespace", () => {
    expect(isValidTracestate("fw529a3039@dt=fw529a3039")).toBe(true);
    expect(isValidTracestate(" rojo=1 , congo=2 ")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["no value", "rojo"],
    ["no key", "=value"],
    ["uppercase key", "Rojo=1"],
    ["an equals sign inside a value", "rojo=a=b"],
    ["over 32 members", Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",")],
  ])("rejects %s", (_label, value) => {
    expect(isValidTracestate(value)).toBe(false);
  });
});

describe("isValidBaggage", () => {
  it("accepts token keys, properties, and multiple members", () => {
    expect(isValidBaggage("userId=alice")).toBe(true);
    expect(isValidBaggage("userId=alice,serverNode=DF%2028")).toBe(true);
    expect(isValidBaggage("key1=value1;property1;property2")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["no value delimiter", "userId"],
    ["no key", "=alice"],
    ["an empty member", "userId=alice,,serverNode=1"],
    ["a key with a space", "user Id=alice"],
    ["over 8192 bytes", `k=${"v".repeat(9000)}`],
    [
      "over 180 members",
      Array.from({ length: 181 }, (_, i) => `k${i}=v`).join(","),
    ],
  ])("rejects %s", (_label, value) => {
    expect(isValidBaggage(value)).toBe(false);
  });
});

describe("sanitizeTraceContext", () => {
  it("returns undefined when there is no context", () => {
    expect(sanitizeTraceContext(undefined)).toBeUndefined();
  });

  it("drops the whole context when traceparent is malformed", () => {
    expect(
      sanitizeTraceContext({
        traceparent: "not-a-traceparent",
        tracestate: "rojo=1",
        baggage: "userId=alice",
      }),
    ).toBeUndefined();
  });

  it("keeps a valid parent when tracestate/baggage are malformed", () => {
    expect(
      sanitizeTraceContext({
        traceparent: SPEC_TRACEPARENT,
        tracestate: "Rojo=1",
        baggage: "=alice",
      }),
    ).toEqual({ traceparent: SPEC_TRACEPARENT });
  });

  it("passes a fully valid context through", () => {
    const context = {
      traceparent: SPEC_TRACEPARENT,
      tracestate: "rojo=1",
      baggage: "userId=alice",
    };
    expect(sanitizeTraceContext(context)).toEqual(context);
  });
});

describe("traceContextToMeta", () => {
  it("omits keys with no value rather than sending empty strings", () => {
    expect(traceContextToMeta({ traceparent: SPEC_TRACEPARENT })).toEqual({
      traceparent: SPEC_TRACEPARENT,
    });
  });

  it("emits all three keys when all three are present", () => {
    expect(
      traceContextToMeta({
        traceparent: SPEC_TRACEPARENT,
        tracestate: "rojo=1",
        baggage: "userId=alice",
      }),
    ).toEqual({
      traceparent: SPEC_TRACEPARENT,
      tracestate: "rojo=1",
      baggage: "userId=alice",
    });
  });
});

describe("extractTraceContext", () => {
  it("reads a context back out of a result `_meta`", () => {
    expect(
      extractTraceContext({
        "io.modelcontextprotocol/serverInfo": { name: "x", version: "1" },
        traceparent: SPEC_TRACEPARENT,
        tracestate: "rojo=1",
        baggage: "userId=alice",
      }),
    ).toEqual({
      traceparent: SPEC_TRACEPARENT,
      tracestate: "rojo=1",
      baggage: "userId=alice",
    });
  });

  it.each([
    ["no meta", undefined],
    ["null meta", null],
    ["meta without trace keys", { progressToken: 1 }],
    ["a malformed traceparent", { traceparent: "nope" }],
    ["a non-string traceparent", { traceparent: 42 }],
  ])("returns undefined for %s", (_label, meta) => {
    expect(
      extractTraceContext(meta as Record<string, unknown> | undefined | null),
    ).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  rebuildSentryEvent,
  rebuildSentryFrameLocations,
  withSentryBoundary,
} from "../src/internal/telemetry";
import {
  rebuildSentryClientReport,
  sentryInjectedDebugId,
} from "../src/internal/sentry-protocol";
import { sdkSentryEntryKind } from "../src/internal/sentry-boundary";

const file = "assets/app.js";
const debugId = "bd2cfb5e-a428-4bad-91f5-4656d832cf73";
const catalog = {
  files: [file],
  platform: "javascript" as const,
  dist: "web",
  environment: "prod" as const,
  frameAliases: { "https://app.test/assets/app.js": file },
  frameOutputNames: { [file]: `app:///${file}` },
  frameDebugIds: { [`app:///${file}`]: debugId },
  slugs: ["internal/unknown"],
  diagnosticFields: { code: ["FORBIDDEN"] },
};
const event = (line = 1) => ({
  event_id: "a".repeat(32),
  message: "PRIVATE_SENTINEL",
  debug_meta: {
    images: [{ code_file: "PRIVATE_SENTINEL", debug_id: "PRIVATE_SENTINEL" }],
  },
  exception: {
    values: [
      {
        type: "Error",
        value: "PRIVATE_SENTINEL",
        stacktrace: {
          frames: [
            {
              filename: "https://app.test/assets/app.js",
              lineno: line,
              colno: 5,
              function: "PRIVATE_SENTINEL",
            },
          ],
        },
      },
    ],
  },
});

describe("Sentry protocol reconstruction", () => {
  it("preserves only build-bound map identifiers and keeps frame positions out of grouping", () => {
    const first = rebuildSentryEvent(event(1), catalog);
    const second = rebuildSentryEvent(event(2), catalog);
    expect(first).toMatchObject({
      environment: "prod",
      platform: "javascript",
      dist: "web",
      debug_meta: {
        images: [{ code_file: `app:///${file}`, debug_id: debugId }],
      },
      fingerprint: ["{{ default }}", "Error"],
    });
    expect(second.fingerprint).toEqual(first.fingerprint);
    expect(
      rebuildSentryEvent({ ...event(), message: "OTHER_CONTENT" }, catalog)
        .fingerprint
    ).toEqual(first.fingerprint);
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SENTINEL");
    expect(
      rebuildSentryEvent(event(), { ...catalog, frameDebugIds: {} })
    ).not.toHaveProperty("debug_meta");
  });

  it("retains approved chat facts but denies arbitrary values and fields", () => {
    const extra = {
      slug: "internal/unknown",
      code: "FORBIDDEN",
      chunkType: "tool-*",
      httpStatus: 502,
      fieldCount: 8,
      contentType: "application/json",
      requestId: "bd2cfb5e-a428-4bad-91f5-4656d832cf73",
      unknown: "PRIVATE_SENTINEL",
    };
    const result = rebuildSentryEvent({ ...event(), extra }, catalog);
    expect(result.extra).toMatchObject(extraWithoutUnknown(extra));
    const dirty = rebuildSentryEvent(
      {
        ...event(),
        extra: {
          slug: "PRIVATE_SENTINEL",
          requestId: "PRIVATE_SENTINEL",
          chunkType: "tool-PRIVATE_SENTINEL",
          fieldCount: 1001,
          httpStatus: 700,
        },
      },
      catalog
    );
    expect(dirty.extra).toEqual({ dropped_frames: 0 });
  });

  it("rebuilds headers, reports finite loss counters and rejects report contents", async () => {
    const send = vi.fn(
      async (_value: [Record<string, unknown>, unknown[]]) => ({})
    );
    const dropped = vi.fn();
    const transport = withSentryBoundary(
      { send, flush: async () => true },
      () => catalog,
      () => false,
      dropped
    );
    const report = {
      timestamp: 100,
      discarded_events: [
        { reason: "before_send", category: "error", quantity: 2 },
        { reason: "PRIVATE_SENTINEL", category: "error", quantity: 1 },
      ],
      arbitrary: "PRIVATE_SENTINEL",
    };
    await transport.send([
      { event_id: "PRIVATE_SENTINEL", arbitrary: "PRIVATE_SENTINEL" },
      [
        [{ type: "event" }, event()],
        [{ type: "attachment" }, "PRIVATE_SENTINEL"],
        [{ type: "client_report" }, report],
      ],
    ] as never);
    const output = send.mock.calls[0][0];
    expect(output[0]).toEqual({
      event_id: "a".repeat(32),
      sent_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(dropped).toHaveBeenCalledWith("before_send", "attachment", 1);
    expect(output[1]).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain("PRIVATE_SENTINEL");
    expect(
      rebuildSentryClientReport({ ...report, timestamp: "100" })
    ).toBeNull();
  });

  it("recognizes fixed Windows package/source entries without trusting other rebundles", () => {
    expect(sdkSentryEntryKind("C:\\repo\\sdk\\dist\\index.js")).toBe("package");
    expect(sdkSentryEntryKind("C:\\repo\\sdk\\dist\\operations.js")).toBe(
      "package"
    );
    expect(
      sdkSentryEntryKind("C:\\repo\\sdk\\dist\\host-config\\index.js")
    ).toBe("package");
    expect(
      sdkSentryEntryKind("C:\\repo\\sdk\\src\\internal\\sentry-boundary.ts")
    ).toBe("source");
    expect(sdkSentryEntryKind("C:\\customer\\bundle.js")).toBeUndefined();
    expect(
      sentryInjectedDebugId(
        `globalThis._sentryDebugIdIdentifier="sentry-dbid-${debugId}"`
      )
    ).toBe(debugId);
    expect(sentryInjectedDebugId(`code();\n//# debugId=${debugId}\n`)).toBe(
      debugId
    );
    expect(
      sentryInjectedDebugId(`const customer="${debugId}"`)
    ).toBeUndefined();
    expect(
      sentryInjectedDebugId(
        'globalThis._sentryDebugIdIdentifier="sentry-dbid-------------------------------------"'
      )
    ).toBeUndefined();
  });

  it("rebuilds full-event map metadata against only the retained emitted filenames", () => {
    const result = rebuildSentryFrameLocations(event(), catalog);
    expect(result.debug_meta).toEqual({
      images: [
        { type: "sourcemap", code_file: `app:///${file}`, debug_id: debugId },
      ],
    });
    expect(JSON.stringify(result.exception.values[0].stacktrace)).not.toContain(
      "PRIVATE_SENTINEL"
    );
    expect(
      rebuildSentryFrameLocations(event(), { ...catalog, files: [] })
    ).not.toHaveProperty("debug_meta");
  });

  it("uses one valid event per envelope and makes its generated ID match the header", async () => {
    const send = vi.fn(
      async (_value: [Record<string, unknown>, unknown[]]) => ({})
    );
    const transport = withSentryBoundary(
      { send, flush: async () => true },
      () => catalog,
      () => false
    );
    await transport.send([
      {},
      [
        [{ type: "event" }, null],
        [{ type: "event" }, { ...event(), event_id: "bad" }],
        [{ type: "transaction" }, {}],
      ],
    ] as never);
    const output = send.mock.calls[0][0];
    expect(output[1]).toHaveLength(1);
    expect(output[0].event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(output[1][0]).toMatchObject([
      { type: "event" },
      { event_id: output[0].event_id },
    ]);
  });
});

function extraWithoutUnknown({
  unknown: _unknown,
  ...extra
}: Record<string, unknown>) {
  return extra;
}

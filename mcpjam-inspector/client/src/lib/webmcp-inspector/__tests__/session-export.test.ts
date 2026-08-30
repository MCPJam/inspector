import { describe, it, expect } from "vitest";
import {
  buildOtlpExport,
  buildSessionExport,
  exportFilename,
  type WebMcpExportInput,
} from "../session-export";
import type {
  WebMcpActivityEntry,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

const SESSION: WebMcpSessionPublic = {
  sessionId: "session-abcdef123",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1_000,
  expiresAt: 2_000,
  hardExpiresAt: 3_000,
  viewportTransport: { kind: "native-window" },
  protocolVersion: 1,
};

const TOOL: WebMcpToolDescriptor = {
  toolKey: "https://shop.test::add_to_cart",
  name: "add_to_cart",
  origin: "https://shop.test",
  fromSubframe: false,
  description: "Add an item",
  registrationKind: "imperative",
};

function activity(): WebMcpActivityEntry[] {
  return [
    { id: "a0", ts: 1_000, kind: "session_started", url: "https://shop.test/" },
    {
      id: "a1",
      ts: 1_100,
      kind: "navigated",
      url: "https://shop.test/",
      origin: "https://shop.test",
    },
    {
      id: "a2",
      ts: 1_200,
      kind: "invocation_started",
      invokeId: "inv-1",
      toolKey: TOOL.toolKey,
      source: "chat",
      input: { sku: "ABC" },
      screenshotBase64: "c2hvdA==",
    },
    {
      id: "a3",
      ts: 1_500,
      kind: "invocation_settled",
      invokeId: "inv-1",
      toolKey: TOOL.toolKey,
      source: "chat",
      state: "succeeded",
      durationMs: 300,
      output: "added",
      screenshotBase64: "c2hvdA==",
    },
    {
      id: "a4",
      ts: 1_900,
      kind: "invocation_settled",
      invokeId: "inv-2",
      toolKey: TOOL.toolKey,
      source: "manual",
      state: "timeout",
      durationMs: 60_000,
      errorMessage: "did not respond in time",
    },
  ];
}

function input(overrides: Partial<WebMcpExportInput> = {}): WebMcpExportInput {
  return {
    session: SESSION,
    tools: [TOOL],
    activity: activity(),
    exportedAt: 2_500,
    ...overrides,
  };
}

describe("buildSessionExport", () => {
  it("carries the session, its tools and the whole timeline", () => {
    const result = buildSessionExport(input());
    expect(result.format).toBe("mcpjam.webmcp.session");
    expect(result.session).toMatchObject({
      sessionId: SESSION.sessionId,
      url: "https://shop.test/",
      viewportTransport: "native-window",
    });
    expect(result.tools).toHaveLength(1);
    expect(result.activity).toHaveLength(5);
  });

  it("counts outcomes so a reader does not have to", () => {
    expect(buildSessionExport(input()).summary).toEqual({
      toolCount: 1,
      invocations: 2,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 1,
      navigations: 1,
    });
  });

  it("drops screenshots unless they were asked for", () => {
    // They roughly double the size, so including them is a choice rather than
    // the default.
    const without = buildSessionExport(input());
    expect(without.activity.some((entry) => "screenshotBase64" in entry)).toBe(
      false,
    );

    const withShots = buildSessionExport(input({ includeScreenshots: true }));
    expect(
      withShots.activity.filter((entry) => "screenshotBase64" in entry),
    ).toHaveLength(2);
  });

  it("exports a session whose browser has already closed", () => {
    // The timeline is most wanted after something went wrong, which is exactly
    // when the session is gone.
    const result = buildSessionExport(input({ session: undefined }));
    expect(result.session).toBeNull();
    expect(result.activity).toHaveLength(5);
  });

  it("handles a session with nothing in it", () => {
    const result = buildSessionExport(
      input({ session: undefined, tools: [], activity: [] }),
    );
    expect(result.summary.invocations).toBe(0);
    expect(result.activity).toEqual([]);
  });
});

describe("buildOtlpExport", () => {
  function spansOf(payload: unknown) {
    return (
      payload as {
        resourceSpans: { scopeSpans: { spans: Record<string, never>[] }[] }[];
      }
    ).resourceSpans[0].scopeSpans[0].spans as unknown as Record<
      string,
      unknown
    >[];
  }

  it("emits a root session span with one child per invocation", () => {
    const spans = spansOf(buildOtlpExport(input()));
    // Registrations and navigations are events about the page, not units of
    // work — spanning them would make every trace mostly noise.
    expect(spans).toHaveLength(3);
    expect(spans[0].name).toBe("webmcp.session");
    expect(spans[1].name).toBe("webmcp.invoke add_to_cart");
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);
  });

  it("uses ids of the width OTLP requires", () => {
    const spans = spansOf(buildOtlpExport(input()));
    for (const span of spans) {
      expect(String(span.traceId)).toMatch(/^[0-9a-f]{32}$/);
      expect(String(span.spanId)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("is stable across exports, so two runs can be compared", () => {
    const first = spansOf(buildOtlpExport(input()));
    const second = spansOf(buildOtlpExport(input({ exportedAt: 9_999 })));
    expect(second[1].traceId).toBe(first[1].traceId);
    expect(second[1].spanId).toBe(first[1].spanId);
  });

  it("spans the real invocation window, in nanoseconds", () => {
    const spans = spansOf(buildOtlpExport(input()));
    // Started at 1_200, settled at 1_500.
    expect(spans[1].startTimeUnixNano).toBe("1200000000");
    expect(spans[1].endTimeUnixNano).toBe("1500000000");
  });

  it("marks a failed invocation with an error status and its message", () => {
    const spans = spansOf(buildOtlpExport(input()));
    expect(spans[1].status).toEqual({ code: 1 });
    expect(spans[2].status).toMatchObject({
      code: 2,
      message: "did not respond in time",
    });
  });

  it("records provenance and source on each invocation span", () => {
    const spans = spansOf(buildOtlpExport(input()));
    const attributes = (
      spans[1].attributes as { key: string; value: never }[]
    ).map((item) => item.key);
    expect(attributes).toEqual(
      expect.arrayContaining([
        "webmcp.tool.origin",
        "webmcp.invocation.source",
        "webmcp.invocation.state",
        "webmcp.tool.registration",
      ]),
    );
  });

  it("derives a start time when the started entry has scrolled away", () => {
    // The ring is bounded, so a long session can settle an invocation whose
    // start is no longer in the timeline.
    const trimmed = activity().filter((entry) => entry.id !== "a2");
    const spans = spansOf(buildOtlpExport(input({ activity: trimmed })));
    expect(spans[1].startTimeUnixNano).toBe("1200000000"); // 1_500 - 300ms
  });

  it("produces a valid trace for a session with no invocations", () => {
    const spans = spansOf(
      buildOtlpExport(input({ activity: [activity()[0]] })),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("webmcp.session");
  });
});

describe("exportFilename", () => {
  it("names the file by session and kind", () => {
    // A real session id is a UUID, so the first eight alphanumerics are the
    // distinguishing part — spending them on separators would make every
    // export from a session look identical.
    expect(exportFilename("426581af-6f6c-43cf-8d02-643e09b240b0", "json")).toBe(
      "webmcp-session-426581af.json",
    );
    expect(exportFilename("426581af-6f6c-43cf-8d02-643e09b240b0", "otlp")).toBe(
      "webmcp-session-426581af.otlp.json",
    );
  });

  it("still names a file when the session is gone or unusable", () => {
    expect(exportFilename(undefined, "json")).toBe(
      "webmcp-session-unknown.json",
    );
    expect(exportFilename("---", "json")).toBe("webmcp-session-unknown.json");
  });
});

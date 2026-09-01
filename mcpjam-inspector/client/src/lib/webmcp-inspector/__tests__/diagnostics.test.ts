/**
 * The diagnostics payload.
 *
 * Its whole value is being complete and copy-able in one click: a person
 * describing "the viewport looks bad" cannot see which of four fallbacks they
 * are on, and asking them one field at a time is a support round trip per
 * field. So what this pins is the SHAPE — that the fields worth having are
 * there — and that a copy which did not happen is never reported as one that
 * did.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebMcpSessionPublic } from "@/shared/webmcp-inspector-protocol";

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (text: string) => clipboard.copy(text),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: { success: toasts.success, error: toasts.error },
}));

import { buildWebMcpDiagnostics, copyWebMcpDiagnostics } from "../diagnostics";
import {
  noteFrameTransportRung,
  notePainted,
  resetFrameStatsFlagForTests,
} from "../frame-stats";

const SESSION: WebMcpSessionPublic = {
  sessionId: "session-1",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1,
  expiresAt: 2,
  hardExpiresAt: 3,
  viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
  streamQuality: 45,
  protocolVersion: 1,
};

const TRANSPORT = {
  rung: "sse-frames" as const,
  attempts: 4,
  latched: true,
};

describe("webmcp diagnostics", () => {
  beforeEach(() => {
    clipboard.copy.mockClear().mockResolvedValue(true);
    toasts.success.mockClear();
    toasts.error.mockClear();
    localStorage.clear();
    resetFrameStatsFlagForTests();
  });

  it("carries the session, the transport and the viewer's own facts", () => {
    const report = buildWebMcpDiagnostics({
      session: SESSION,
      frameTransport: TRANSPORT,
      frame: { deviceWidth: 2560, deviceHeight: 1600, seq: 42 },
    });

    expect(report).toMatchObject({
      sessionId: "session-1",
      status: "ready",
      url: "https://shop.test/",
      viewportTransport: { kind: "frame-stream", width: 1280, height: 800 },
      // The four things that are invisible on screen and decide everything
      // about how the pane looks.
      streamQuality: 45,
      frameTransport: TRANSPORT,
      frame: { deviceWidth: 2560, deviceHeight: 1600, seq: 42 },
    });
    expect(report.devicePixelRatio).toBe(window.devicePixelRatio);
    expect(report.userAgent).toBe(window.navigator.userAgent);
    expect(typeof report.ts).toBe("number");
  });

  it("strips the parts of a URL that carry secrets", async () => {
    await copyWebMcpDiagnostics({
      session: {
        ...SESSION,
        url: "https://user:pw@shop.test/checkout?access_token=secret#frag",
      },
      frameTransport: TRANSPORT,
    });
    const copied = String(clipboard.copy.mock.calls[0]![0]);

    // This payload exists to be pasted into an issue, and a query string is
    // where session tokens and magic-link codes live.
    expect(copied).not.toContain("secret");
    expect(copied).not.toContain("pw@");
    expect(copied).not.toContain("#frag");
    // The page is still identifiable, and the reader is told something was
    // dropped rather than left wondering why it does not match their address
    // bar.
    expect(JSON.parse(copied).url).toBe(
      "https://shop.test/checkout [query redacted]",
    );
  });

  it("says so rather than guessing when the URL will not parse", () => {
    const report = buildWebMcpDiagnostics({
      session: { ...SESSION, url: "not a url" },
      frameTransport: TRANSPORT,
    });
    expect(report.url).toBe("[unparseable url]");
  });

  it("reports absent numbers rather than made-up ones", () => {
    const report = buildWebMcpDiagnostics({
      session: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
    });
    expect(report.sessionId).toBeUndefined();
    // Measurement is off by default, so the buckets are empty rather than
    // invented — a zero p95 would read as "instant".
    expect(report.frameStats.captureToPaint.n).toBe(0);
    expect(report.frameStats.byTransport).toEqual({});
  });

  it("includes the percentiles once measurement is on, split by transport", () => {
    localStorage.setItem("webmcp:frame-stats", "1");
    resetFrameStatsFlagForTests();
    vi.setSystemTime(1_000_000);
    noteFrameTransportRung("ws");
    notePainted({ ts: 999_950, seq: 1 });

    const report = buildWebMcpDiagnostics({
      session: SESSION,
      frameTransport: TRANSPORT,
    });
    expect(report.frameStats.captureToPaint.n).toBe(1);
    expect(report.frameStats.byTransport.ws).toMatchObject({ n: 1, p50: 50 });
    vi.useRealTimers();
  });

  it("copies the payload as formatted JSON", async () => {
    await copyWebMcpDiagnostics({
      session: SESSION,
      frameTransport: TRANSPORT,
    });
    const copied = clipboard.copy.mock.calls[0]![0] as unknown as string;
    expect(JSON.parse(copied)).toMatchObject({
      sessionId: "session-1",
      frameTransport: TRANSPORT,
    });
    // Indented: this gets pasted into an issue and read by a person.
    expect(copied).toContain("\n  ");
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("says so when the clipboard refused", async () => {
    clipboard.copy.mockResolvedValue(false);
    expect(
      await copyWebMcpDiagnostics({
        session: SESSION,
        frameTransport: TRANSPORT,
      }),
    ).toBe(false);
    // The clipboard is refused often enough — permissions, an insecure origin,
    // a browser without the API — that a success toast for a copy that never
    // happened is a real way to lose somebody's bug report.
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

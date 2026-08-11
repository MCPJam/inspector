import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.mock` factories are hoisted above module-scope consts, so the spies have
// to be created inside `vi.hoisted` to exist by the time they run.
const { reportCaught, isErrorCaptureSurface } = vi.hoisted(() => ({
  reportCaught: vi.fn(),
  isErrorCaptureSurface: vi.fn(() => true),
}));

vi.mock("../error-reporting", () => ({ reportCaught }));
vi.mock("../PosthogUtils", () => ({
  isErrorCaptureSurface,
  isCredentialBearingPath: () => false,
}));

import { reportChatFailure } from "../chat-error-reporting";

beforeEach(() => {
  reportCaught.mockClear();
  isErrorCaptureSurface.mockReturnValue(true);
});

describe("reportChatFailure", () => {
  it("reports a hosted 502 that would otherwise leave no client trace", () => {
    const sent = reportChatFailure(new Error("<html>502 Bad Gateway</html>"), {
      ok: false,
      status: 502,
      contentType: "text/html",
      requestId: "req_abc",
    });

    expect(sent).toBe(true);
    expect(reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = reportCaught.mock.calls[0]!;
    expect(options.source).toBe("chat_request_failed");
    expect(options.extra).toMatchObject({
      httpStatus: 502,
      contentType: "text/html",
      requestId: "req_abc",
    });
    expect((error as Error).message).toBe("chat_request_failed:502");
  });

  it("uses a synthetic message so the Sentry ignore-list cannot swallow it", () => {
    // `BROWSER_IGNORE_ERRORS` drops "Failed to fetch" BY MESSAGE, and that is
    // exactly what a failed chat request arrives as. Reporting the raw message
    // would mean reporting nothing at all.
    reportChatFailure(new Error("Failed to fetch"), {
      ok: false,
      status: 502,
    });

    const [error, options] = reportCaught.mock.calls[0]!;
    expect((error as Error).message).not.toContain("Failed to fetch");
    // The real message is still recoverable for debugging.
    expect(options.extra.rawMessage).toBe("Failed to fetch");
  });

  it("tags a mid-stream failure differently from a failed request", () => {
    reportChatFailure(new Error("provider blew up"), {
      ok: true,
      status: 200,
      requestId: "req_xyz",
    });

    const [error, options] = reportCaught.mock.calls[0]!;
    expect(options.source).toBe("chat_stream_error");
    expect((error as Error).message).toBe("chat_stream_error");
    // The request id survives an ok response, which is what joins this event
    // to the server-side row.
    expect(options.extra.requestId).toBe("req_xyz");
  });

  it("still reports when no response was ever seen", () => {
    expect(reportChatFailure(new Error("boom"), null)).toBe(true);
    expect(reportCaught.mock.calls[0]![1].source).toBe("chat_stream_error");
  });

  it("does not report an abort — that is the user pressing Stop", () => {
    // The synthetic message is specifically designed to defeat the by-message
    // ignore list, so aborts must be dropped here rather than smuggled past it.
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";

    expect(reportChatFailure(abort, { ok: true, status: 200 })).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("does not report a Node-style ABORT_ERR either", () => {
    const abort = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });

    expect(reportChatFailure(abort, null)).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("stays silent on a self-hosted surface", () => {
    // `reportCaught`'s Sentry leg is ungated, so the gate has to be here.
    isErrorCaptureSurface.mockReturnValue(false);

    expect(reportChatFailure(new Error("boom"), { ok: false, status: 502 })).toBe(
      false,
    );
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("truncates a huge upstream body instead of shipping it whole", () => {
    reportChatFailure(new Error("x".repeat(50_000)), { ok: false, status: 502 });

    const rawMessage = reportCaught.mock.calls[0]![1].extra.rawMessage as string;
    expect(rawMessage.length).toBeLessThanOrEqual(1000);
  });

  it("carries the classified origin so the event is triageable", () => {
    reportChatFailure(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
      null,
    );

    expect(reportCaught.mock.calls[0]![1].extra).toMatchObject({
      slug: "transport/econnrefused",
      origin: "user_config",
    });
  });
});

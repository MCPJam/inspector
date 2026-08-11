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
    // The fetch itself rejected — DNS failure, connection refused, offline —
    // so there is no status to attribute. `chatFetch` clears its ref before
    // awaiting precisely so this arrives as `null` rather than as the PREVIOUS
    // turn's status and request id, which would group a fresh network failure
    // under a stale 502 and link it to somebody else's server request.
    expect(reportChatFailure(new Error("boom"), null)).toBe(true);
    const [error, options] = reportCaught.mock.calls[0]!;
    expect(options.source).toBe("chat_stream_error");
    expect((error as Error).message).toBe("chat_stream_error");
    expect(options.extra).not.toHaveProperty("httpStatus");
    expect(options.extra).not.toHaveProperty("requestId");
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

  it("does not report a failure the catalog blames on the user", () => {
    // Same rule the server envelopes follow. A chat turn dying because the
    // user's own MCP server refused a connection is not an MCPJam incident,
    // and this is a high-volume path — reporting it would rebuild on the
    // client the noise the server-side policy removes.
    const sent = reportChatFailure(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
      null,
    );

    expect(sent).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("carries the classified origin so what IS reported stays triageable", () => {
    reportChatFailure(new Error("<html>502 Bad Gateway</html>"), {
      ok: false,
      status: 502,
    });

    expect(reportCaught.mock.calls[0]![1].extra).toMatchObject({
      slug: "internal/unknown",
      origin: "ambiguous",
    });
  });

  it("sends the describer's redacted message, not the raw upstream text", () => {
    // The raw text here is an upstream RESPONSE BODY — exactly the kind of
    // thing that carries a bearer token — and it would otherwise go straight
    // to Sentry and PostHog.
    reportChatFailure(
      new Error("upstream said: Authorization: Bearer sk-abcdefghijklmnop"),
      { ok: false, status: 502 },
    );

    const rawMessage = reportCaught.mock.calls[0]![1].extra.rawMessage as string;
    expect(rawMessage).not.toContain("sk-abcdefghijklmnop");
  });

  it("does not copy the original stack, which would smuggle the message back", () => {
    // V8 renders a stack as "<name>: <message>\n at …", so copying it would
    // defeat the redaction above.
    reportChatFailure(new Error("secret-ish upstream body"), {
      ok: false,
      status: 502,
    });

    const error = reportCaught.mock.calls[0]![0] as Error;
    expect(error.stack ?? "").not.toContain("secret-ish upstream body");
  });
});

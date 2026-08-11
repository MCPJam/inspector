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

  it("does not report an unattributable mid-stream failure", () => {
    // The response was fine; something inside the turn failed for a reason the
    // catalog cannot place. Under the same `mcpjam`-only policy the server
    // applies, an unattributable failure on a high-volume path does not page.
    expect(
      reportChatFailure(new Error("provider blew up"), {
        ok: true,
        status: 200,
        requestId: "req_xyz",
      }),
    ).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("does not report when no response was ever seen", () => {
    // The fetch itself rejected — DNS failure, connection refused, offline. A
    // user's network dying is not an MCPJam incident, and there is no status
    // to attribute it with. `chatFetch` clears its ref before awaiting so this
    // arrives as `null` rather than as the PREVIOUS turn's status, which would
    // otherwise mis-attribute a fresh network failure to a stale 502.
    expect(reportChatFailure(new Error("boom"), null)).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("attributes a 5xx from OUR chat route to MCPJam", () => {
    // The describer sees only an HTML page — `internal/unknown`, i.e.
    // `ambiguous` — so a strict policy would report nothing for the exact
    // failure this exists to catch. The STATUS closes that gap, the same way
    // the server's `describeBackendStreamFailure` does.
    expect(
      reportChatFailure(new Error("<html>502</html>"), { ok: false, status: 502 }),
    ).toBe(true);
    expect(reportCaught.mock.calls[0]![1].extra.origin).toBe("mcpjam");
  });

  it("does not treat a 4xx as MCPJam's failure", () => {
    expect(
      reportChatFailure(new Error("bad request"), { ok: false, status: 400 }),
    ).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("does not let a 5xx overrule positive user-fault evidence", () => {
    // An ECONNREFUSED to the user's own MCP server stays theirs even if it
    // somehow arrived alongside a 5xx from our route.
    expect(
      reportChatFailure(
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
          code: "ECONNREFUSED",
        }),
        { ok: false, status: 502 },
      ),
    ).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
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

  it("carries the classified slug so what IS reported stays triageable", () => {
    reportChatFailure(new Error("<html>502 Bad Gateway</html>"), {
      ok: false,
      status: 502,
    });

    expect(reportCaught.mock.calls[0]![1].extra).toMatchObject({
      slug: "internal/unknown",
      origin: "mcpjam",
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

  it("honors the server's origin header instead of guessing from the 5xx", () => {
    // The chat route 500s when the USER's MCP server fails to list tools. It
    // classified that with the error object in hand and said so on the
    // response; the status-only fallback here would relabel it `mcpjam` and
    // page us for somebody else's outage.
    const sent = reportChatFailure(new Error("<html>500</html>"), {
      ok: false,
      status: 500,
      origin: "user_server",
    });

    expect(sent).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("still reports when the server's header says the failure is ours", () => {
    const sent = reportChatFailure(new Error("<html>500</html>"), {
      ok: false,
      status: 500,
      origin: "mcpjam",
    });

    expect(sent).toBe(true);
  });

  it("falls back to the status when the header is absent or unrecognized", () => {
    // A proxy that strips headers, or an older server, must not silently turn
    // the 5xx path back off.
    expect(
      reportChatFailure(new Error("<html>502</html>"), {
        ok: false,
        status: 502,
        origin: "not-an-origin",
      }),
    ).toBe(true);
  });
});

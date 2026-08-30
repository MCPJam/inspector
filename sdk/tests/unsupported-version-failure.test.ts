import { describe, expect, it } from "vitest";
import { readUnsupportedVersionFailure } from "../src/mcp-client-manager/errors.js";

const ERA_NEGOTIATION_FAILED_CODE = "ERA_NEGOTIATION_FAILED";

/** An `SdkError(EraNegotiationFailed)` as the upstream client raises it. */
function eraNegotiationError(message: string): Error {
  return Object.assign(new Error(message), {
    code: ERA_NEGOTIATION_FAILED_CODE,
  });
}

/**
 * `UnsupportedProtocolVersionError` by shape, not by import: the app resolves
 * `@modelcontextprotocol/client` to a different copy than the SDK does, which
 * is exactly why the predicate matches on name + shape.
 */
function unsupportedVersionError(supported: string[], requested: string): Error {
  return Object.assign(new Error("Unsupported protocol version"), {
    name: "UnsupportedProtocolVersionError",
    supported,
    requested,
  });
}

describe("readUnsupportedVersionFailure", () => {
  it("reads the server's own list when discover parsed and simply didn't match", () => {
    const verdict = readUnsupportedVersionFailure(
      unsupportedVersionError(["2025-03-26", "2025-06-18"], "2026-07-28"),
    );

    expect(verdict).toEqual({ supported: ["2025-03-26", "2025-06-18"] });
  });

  it("recognizes the pin refusal, which carries no list", () => {
    const verdict = readUnsupportedVersionFailure(
      eraNegotiationError(
        "Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 via server/discover (no fallback in pin mode)",
      ),
    );

    expect(verdict).toEqual({ supported: [] });
  });

  // The reason this predicate exists instead of a bare code check. Every one
  // of these is an OUTAGE wearing the same error code: reporting them as a
  // version mismatch would blame the user's dropdown for someone's server
  // being down — and, because that slug is `user_config`, stop them paging.
  it.each([
    [
      "probe hit an HTTP status",
      "Version negotiation failed: the server answered the probe with HTTP 503",
    ],
    [
      "probe hit a network failure",
      "Version negotiation probe failed: fetch failed",
    ],
    [
      "transport closed mid-probe",
      "Version negotiation failed: the transport was closed during the server/discover probe",
    ],
  ])("ignores an era-negotiation failure that is really %s", (_name, message) => {
    expect(readUnsupportedVersionFailure(eraNegotiationError(message))).toBeUndefined();
  });

  it("ignores ordinary transport errors", () => {
    expect(readUnsupportedVersionFailure(new Error("fetch failed"))).toBeUndefined();
    expect(readUnsupportedVersionFailure(undefined)).toBeUndefined();
  });

  it("sees through a wrapper's cause chain", () => {
    // The manager wraps connect failures, so the verdict is rarely the
    // top-level object by the time anything inspects it.
    const wrapped = new Error("Failed to connect to MCP server \"acme\"", {
      cause: unsupportedVersionError(["2025-06-18"], "2026-07-28"),
    });

    expect(readUnsupportedVersionFailure(wrapped)).toEqual({
      supported: ["2025-06-18"],
    });
  });

  // The legacy-pin refusal: a stateful pin narrows the accept-list, the
  // server's `initialize` reply names something else, and the upstream client
  // throws a plain `Error`. Neither shape above matches it, so before this was
  // recognized the failure was reported as "the server appears to be down".
  it("reads the version a legacy initialize refusal names", () => {
    const verdict = readUnsupportedVersionFailure(
      new Error("Server's protocol version is not supported: 2025-06-18"),
    );

    expect(verdict).toEqual({ supported: ["2025-06-18"] });
  });

  // Verbatim from a production connect against mcp.slack.com with a 2025-11-25
  // pin. The manager folds every transport's failure into one message, so the
  // clause lands mid-sentence followed by a period — a greedy capture reports
  // the server as offering "2025-06-18.".
  it("does not swallow sentence punctuation from the wrapped composite", () => {
    const verdict = readUnsupportedVersionFailure(
      new Error(
        'Failed to connect to MCP server "slack" using HTTP transports. ' +
          "Streamable HTTP error: Server's protocol version is not supported: 2025-06-18. " +
          "SSE error: SSE error: Non-200 status code (405).",
      ),
    );

    expect(verdict).toEqual({ supported: ["2025-06-18"] });
  });

  it("ignores a refusal that names no version", () => {
    expect(
      readUnsupportedVersionFailure(
        new Error("Server's protocol version is not supported: banana"),
      ),
    ).toBeUndefined();
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;

    expect(readUnsupportedVersionFailure(a)).toBeUndefined();
  });
});

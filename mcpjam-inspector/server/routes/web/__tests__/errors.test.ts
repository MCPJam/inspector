import { describe, expect, it } from "vitest";

import { ErrorCode, WebRouteError, mapRuntimeError } from "../errors.js";

describe("mapRuntimeError", () => {
  it("passes WebRouteError through unchanged", () => {
    const original = new WebRouteError(404, ErrorCode.NOT_FOUND, "missing");
    expect(mapRuntimeError(original)).toBe(original);
  });

  it("maps timeout messages to 504", () => {
    expect(mapRuntimeError(new Error("Request timed out")).status).toBe(504);
    expect(mapRuntimeError(new Error("Timeout exceeded")).status).toBe(504);
  });

  it("maps ECONN* errno messages to 502", () => {
    expect(
      mapRuntimeError(new Error("connect ECONNREFUSED 127.0.0.1:8080")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("read ECONNRESET")).status).toBe(502);
    expect(mapRuntimeError(new Error("ECONNABORTED")).status).toBe(502);
  });

  it("maps standard connection-failure phrases to 502", () => {
    expect(
      mapRuntimeError(new Error("Connection refused by peer")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("Connection reset")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("Failed to connect to upstream")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("fetch failed")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("getaddrinfo ENOTFOUND example.com")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("socket hang up")).status).toBe(502);
  });

  it("does NOT misclassify words that merely start with 'econ' as 502", () => {
    // Regression for code-review feedback: the errno branch was originally
    // `\becon[a-z]*` (one `n`), which matches server/tool/case names like
    // "Economics" and re-introduces the same kind of false 502 mapping the
    // fix was meant to eliminate. Require the full `econn` prefix.
    expect(
      mapRuntimeError(new Error("Economics server returned an error")).status,
    ).toBe(500);
    expect(mapRuntimeError(new Error("econometric pipeline")).status).toBe(500);
  });

  it("does NOT misclassify 'Reconnect' as 502", () => {
    // Regression: the previous implementation matched the bare substring
    // "connect", which caught the word "Reconnect" inside upstream errors
    // like the eval-generation attachment guard and surfaced them as 502
    // SERVER_UNREACHABLE.
    const error = new Error(
      "Tool snapshot is missing servers required by the attachment: " +
        "Excalidraw (App). Reconnect the missing server(s) in the inspector " +
        "and try again.",
    );
    const mapped = mapRuntimeError(error);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("falls back to 500 for unrecognized errors", () => {
    const mapped = mapRuntimeError(new Error("Something else went wrong"));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

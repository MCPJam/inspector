import { describe, expect, it } from "vitest";
import { describeError } from "../src/error-describer/index.js";
import {
  isUnreachableTargetFailure,
  OAuthProxyError,
  UNREACHABLE_TARGET_FAILURE,
  unreachableTargetFailure,
} from "../src/oauth-proxy-error.js";

/** What `http.request` emits: Node's own text, the errno on `.code`. */
function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * What a socket with `autoSelectFamily` emits after every address failed:
 * an empty message and the FIRST attempt's code, whatever the others were.
 */
function attemptsError(attempts: Error[]): AggregateError {
  return Object.assign(new AggregateError(attempts, ""), {
    code: (attempts[0] as { code?: string }).code,
  });
}

const ADVICE =
  "Check that the server is running and reachable from this machine.";

describe("unreachableTargetFailure", () => {
  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000", 502],
    ["ECONNRESET", "read ECONNRESET", 502],
    ["ECONNRESET", "socket hang up", 502],
    [
      "ECONNRESET",
      "Client network socket disconnected before secure TLS connection was established",
      502,
    ],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.9:443", 502],
    ["ENETUNREACH", "connect ENETUNREACH 2001:db8::1:443", 502],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.255.255.1:81", 504],
  ])("names %s (%s) and answers %i", (code, message, status) => {
    const original = nodeError(code, message);
    const failure = unreachableTargetFailure(original);

    expect(failure).toBeInstanceOf(OAuthProxyError);
    expect(failure?.status).toBe(status);
    expect(failure?.message).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: ${message}. ${ADVICE}`
    );
    expect(failure?.cause).toBe(original);
  });

  it("puts the caller's hint after the advice", () => {
    const failure = unreachableTargetFailure(
      nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000"),
      "From Docker, use host.docker.internal instead of localhost or 127.0.0.1."
    );

    expect(failure?.message).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: connect ECONNREFUSED 127.0.0.1:3000. ${ADVICE} From Docker, use host.docker.internal instead of localhost or 127.0.0.1.`
    );
  });

  it("keeps Node's message through two wrappers", () => {
    const wrapped = new Error("request failed", {
      cause: new TypeError("fetch failed", {
        cause: nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9"),
      }),
    });

    expect(unreachableTargetFailure(wrapped)?.message).toBe(
      `${UNREACHABLE_TARGET_FAILURE}: connect ECONNREFUSED 127.0.0.1:9. ${ADVICE}`
    );
  });

  describe("when Node tried several addresses", () => {
    it("lists the addresses instead of Node's empty message", () => {
      const failure = unreachableTargetFailure(
        attemptsError([
          nodeError("ECONNREFUSED", "connect ECONNREFUSED ::1:3000"),
          nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000"),
        ])
      );

      expect(failure?.status).toBe(502);
      expect(failure?.message).toBe(
        `${UNREACHABLE_TARGET_FAILURE}: connect ECONNREFUSED ::1:3000; connect ECONNREFUSED 127.0.0.1:3000. ${ADVICE}`
      );
    });

    it("answers 502 when one address timed out and another refused", () => {
      // Node labels the whole error with the first attempt's ETIMEDOUT.
      const failure = unreachableTargetFailure(
        attemptsError([
          nodeError("ETIMEDOUT", "connect ETIMEDOUT 2001:db8::1:3000"),
          nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000"),
        ])
      );

      expect(failure?.status).toBe(502);
    });

    it("answers 504 only when every address timed out", () => {
      const failure = unreachableTargetFailure(
        attemptsError([
          nodeError("ETIMEDOUT", "connect ETIMEDOUT 2001:db8::1:3000"),
          nodeError("ETIMEDOUT", "connect ETIMEDOUT 192.0.2.1:3000"),
        ])
      );

      expect(failure?.status).toBe(504);
    });

    it("is recognized when the first attempt failed with another code", () => {
      const failure = unreachableTargetFailure(
        attemptsError([
          nodeError("EADDRNOTAVAIL", "connect EADDRNOTAVAIL ::1:3000"),
          nodeError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3000"),
        ])
      );

      expect(failure?.status).toBe(502);
      expect(failure?.message).toContain("connect ECONNREFUSED 127.0.0.1:3000");
    });

    it("lists at most three addresses so the advice survives", () => {
      const attempts = [1, 2, 3, 4, 5].map((n) =>
        nodeError("ECONNREFUSED", `connect ECONNREFUSED 192.0.2.${n}:443`)
      );
      const message = unreachableTargetFailure(
        attemptsError(attempts)
      )?.message;

      expect(message).toContain("192.0.2.3:443");
      expect(message).not.toContain("192.0.2.4:443");
      expect(message?.endsWith(ADVICE)).toBe(true);
    });
  });

  it.each([
    [
      "a certificate failure",
      nodeError(
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "unable to verify the first certificate"
      ),
    ],
    [
      "a DNS failure",
      nodeError("ENOTFOUND", "getaddrinfo ENOTFOUND nope.example"),
    ],
    ["a plain error", new Error("connect ECONNREFUSED 127.0.0.1:9")],
    ["the proxy's own refusal", new OAuthProxyError(400, "Invalid URL format")],
    ["a non-error", "connect ECONNREFUSED 127.0.0.1:9"],
  ])("leaves %s alone", (_label, error) => {
    expect(unreachableTargetFailure(error)).toBeUndefined();
  });
});

describe("isUnreachableTargetFailure", () => {
  const reason = `${UNREACHABLE_TARGET_FAILURE}: connect ECONNREFUSED 127.0.0.1:3000. ${ADVICE}`;

  // The debugger wraps the proxy's reason in each step's own sentence, so the
  // match has to find it inside them. These are the production wrappers.
  it.each([
    `Failed to request MCP server: ${reason}`,
    `Failed to request resource metadata: ${reason}`,
    `Authenticated MCP request failed: ${reason}`,
    `Token exchange failed: ${reason}`,
    `Could not discover authorization server metadata. Last error: ${reason}`,
  ])("finds the sentence in %s", (message) => {
    expect(isUnreachableTargetFailure(message)).toBe(true);
  });

  it("does not match Node's text on its own", () => {
    expect(
      isUnreachableTargetFailure(
        "Failed to request MCP server: Backend debug proxy error: 500 Internal Server Error: connect ECONNREFUSED 127.0.0.1:3000"
      )
    ).toBe(false);
  });
});

describe("describeError on an unreachable-target failure", () => {
  it.each([
    [
      "ECONNREFUSED",
      "connect ECONNREFUSED 127.0.0.1:3000",
      "transport/econnrefused",
    ],
    ["ECONNRESET", "socket hang up", "transport/econnreset"],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443", "transport/etimedout"],
  ])("keeps the %s slug", (code, message, slug) => {
    expect(
      describeError(unreachableTargetFailure(nodeError(code, message))).slug
    ).toBe(slug);
  });
});

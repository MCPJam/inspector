import { describe, expect, it } from "vitest";

import {
  normalizeStepFailureMessage,
  oauthStepFailureFingerprint,
} from "../step-failure-fingerprint";

describe("normalizeStepFailureMessage", () => {
  it("collapses addresses so one guard rejection is one class", () => {
    const forAddress = (address: string) =>
      normalizeStepFailureMessage(
        `OAuth proxy target resolves to a private/reserved IP address (${address})`,
      );

    expect(forAddress("10.22.7.151")).toBe(forAddress("198.18.2.250"));
    expect(forAddress("10.22.7.151")).toBe(
      forAddress("fd53:1c5a:1000::c8e3:cf02"),
    );
    expect(forAddress("10.22.7.151")).toContain("(<ip>)");
  });

  it("collapses an address with a port", () => {
    expect(
      normalizeStepFailureMessage("connect ECONNREFUSED 127.0.0.1:9876"),
    ).toBe("connect econnrefused <ip>");
  });

  it("collapses URLs, including a trailing-slash difference", () => {
    // The `iss` mismatch that a trailing slash triggers is one bug, not one
    // per port a user's local authorization server happens to run on.
    expect(
      normalizeStepFailureMessage(
        "Authorization response `iss` does not match: `https://localhost:7218` vs `https://localhost:7218/`",
      ),
    ).toBe("authorization response `iss` does not match: `<url>` vs `<url>`");
  });

  it("keeps HTTP status codes, which distinguish real failure classes", () => {
    const proxyError = (status: string, reason: string) =>
      normalizeStepFailureMessage(
        `Backend debug proxy error: ${status} ${reason}`,
      );

    expect(proxyError("400", "Bad Request")).toContain("400");
    expect(proxyError("500", "Internal Server Error")).toContain("500");
    expect(proxyError("400", "Bad Request")).not.toBe(
      proxyError("401", "Unauthorized"),
    );
  });

  it("collapses ids and ports but not the words around them", () => {
    expect(
      normalizeStepFailureMessage("Unknown client a1b2c3d4e5f6 on port 7218"),
    ).toBe("unknown client <id> on port <n>");
  });

  it("does not mistake prose colons for an address", () => {
    expect(
      normalizeStepFailureMessage(
        "Could not discover authorization server metadata. Last error: null",
      ),
    ).toBe("could not discover authorization server metadata. last error: null");
  });

  it("collapses IPv6 written with a leading `::`", () => {
    // `\b` cannot hold before the first colon, so a `\b`-anchored matcher
    // alone leaves these in the key.
    expect(normalizeStepFailureMessage("connect ECONNREFUSED ::1")).toBe(
      "connect econnrefused <ip>",
    );
    expect(normalizeStepFailureMessage("connect ECONNREFUSED ::1:9876")).toBe(
      "connect econnrefused <ip>",
    );
  });

  it("collapses a bracketed IPv6 endpoint together with its port", () => {
    // The IPv4 rule already takes `127.0.0.1:9876` as one span. Without the
    // same for the bracketed form, the port splits the class — and the
    // host:port rule cannot help, since `]` is not a host character.
    const forEndpoint = (endpoint: string) =>
      normalizeStepFailureMessage(`proxy target resolves to ${endpoint}`);

    expect(forEndpoint("[::1]:443")).toBe(forEndpoint("[::1]:8443"));
    expect(forEndpoint("[::1]:443")).toBe(forEndpoint("[fd53::c8e3]:8443"));
    expect(forEndpoint("[::1]:443")).toBe("proxy target resolves to <ip>");
  });

  it("does not treat an arbitrary bracketed colon run as IPv6", () => {
    // Every group in `(?:[0-9a-f]{0,4}:)+[0-9a-f]{0,4}` could once match zero
    // hex digits, so `[:]`, `[::]`'s malformed neighbors, and a two-group span
    // with no `::` all collapsed as if they were addresses. Only a genuine
    // zero-compressed IPv6 literal should.
    const forBracketed = (text: string) =>
      normalizeStepFailureMessage(`saw ${text} in the response`);

    expect(forBracketed("[:]")).toBe("saw [:] in the response");
    expect(forBracketed("[:::]")).toBe("saw [:::] in the response");
    // Falls to the host:port rule instead — still normalized, just not
    // mislabeled as an IP address.
    expect(forBracketed("[1234:5678]")).toBe("saw [<host>] in the response");
    // The all-zero address is a real (if unusual) IPv6 literal.
    expect(forBracketed("[::]")).toBe("saw <ip> in the response");
  });

  it("collapses a whole UUID, not just its long segments", () => {
    const forId = (id: string) =>
      normalizeStepFailureMessage(`Unknown client ${id}`);

    expect(forId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "unknown client <id>",
    );
    expect(forId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      forId("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    );
  });

  it("collapses host:port regardless of how many digits the port has", () => {
    // A three-digit port survived the >=4-digit rule, so the same failure
    // split by port length as well as by host.
    const forHost = (host: string) =>
      normalizeStepFailureMessage(`connect ECONNREFUSED ${host}`);

    expect(forHost("localhost:443")).toBe(forHost("localhost:8443"));
    expect(forHost("localhost:443")).toBe(forHost("auth.acme.com:8443"));
    expect(forHost("localhost:443")).toBe("connect econnrefused <host>");
  });

  it("collapses a bare host named by a DNS failure", () => {
    const forHost = (host: string) =>
      normalizeStepFailureMessage(`getaddrinfo ENOTFOUND ${host}`);

    expect(forHost("auth.acme.com")).toBe(forHost("auth.other.com"));
    expect(forHost("auth.acme.com")).toBe("getaddrinfo enotfound <host>");
  });

  it("leaves dotted prose alone", () => {
    // The bare-host rule is scoped to errno prefixes precisely so it cannot
    // eat "e.g." or a version number out of an unrelated message.
    expect(
      normalizeStepFailureMessage(
        "invalid_client - Client authentication failed (e.g., unknown client).",
      ),
    ).toBe("invalid_client - client authentication failed (e.g., unknown client).");
  });

  it("normalizes whitespace and bounds the length", () => {
    expect(normalizeStepFailureMessage("  a \n  b  ")).toBe("a b");
    expect(normalizeStepFailureMessage("x".repeat(500))).toHaveLength(200);
  });
});

describe("oauthStepFailureFingerprint", () => {
  it("separates the same message raised at different steps", () => {
    const message = "Authenticated request failed: 400 Bad Request";

    expect(oauthStepFailureFingerprint("token_request", message)).not.toEqual(
      oauthStepFailureFingerprint("authenticated_request", message),
    );
  });

  it("stays stable for the same class at the same step", () => {
    expect(
      oauthStepFailureFingerprint("metadata", "Discovery failed at 10.0.0.1"),
    ).toEqual(
      oauthStepFailureFingerprint("metadata", "Discovery failed at 10.0.0.9"),
    );
  });

  it("never emits an empty grouping key", () => {
    // Sentry treats an empty fingerprint value as its own group; a blank one
    // would quietly rebuild the single-bucket behavior for whitespace errors.
    expect(oauthStepFailureFingerprint("metadata", "   ")).toEqual([
      "oauth_debugger_step",
      "metadata",
      "<empty>",
    ]);
  });
});

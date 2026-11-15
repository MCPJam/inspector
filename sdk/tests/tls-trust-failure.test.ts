import { describe, expect, it } from "vitest";
import { describeError } from "../src/error-describer/index.js";
import {
  isTlsTrustFailure,
  OAuthProxyError,
  TLS_TRUST_FAILURE,
  tlsTrustFailure,
} from "../src/oauth-proxy-error.js";

/** What `https.request` emits: Node's own text, the OpenSSL code on `.code`. */
function nodeTlsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const LEAF =
  "unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca";

describe("tlsTrustFailure", () => {
  it.each([
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", LEAF],
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
    ],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:other.example",
    ],
  ])(
    "names the server's certificate for %s and keeps Node's text",
    (code, message) => {
      const original = nodeTlsError(code, message);
      const failure = tlsTrustFailure(original);

      expect(failure).toBeInstanceOf(OAuthProxyError);
      expect(failure?.status).toBe(502);
      expect(failure?.message).toBe(`${TLS_TRUST_FAILURE}: ${message}`);
      expect(failure?.cause).toBe(original);
    }
  );

  it.each([
    [
      "one wrapper",
      (inner: Error) => new TypeError("fetch failed", { cause: inner }),
    ],
    [
      "two wrappers",
      (inner: Error) =>
        new Error("request failed", {
          cause: new Error("connection failed", { cause: inner }),
        }),
    ],
  ])("keeps Node's message through %s", (_label, wrap) => {
    const wrapped = wrap(
      nodeTlsError(
        "SELF_SIGNED_CERT_IN_CHAIN",
        "self-signed certificate in certificate chain"
      )
    );

    expect(tlsTrustFailure(wrapped)?.message).toBe(
      `${TLS_TRUST_FAILURE}: self-signed certificate in certificate chain`
    );
  });

  it.each([
    [
      "a refused connection",
      nodeTlsError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:9"),
    ],
    ["a plain error", new Error("socket hang up")],
    ["the proxy's own refusal", new OAuthProxyError(400, "Invalid URL format")],
    ["a non-error", "unable to verify the first certificate"],
  ])("leaves %s alone", (_label, error) => {
    expect(tlsTrustFailure(error)).toBeUndefined();
  });
});

describe("isTlsTrustFailure", () => {
  const reason = `${TLS_TRUST_FAILURE}: ${LEAF}`;

  // The debugger wraps the proxy's reason in each step's own sentence, so the
  // match has to find it inside them. These are the production wrappers.
  it.each([
    `Failed to request MCP server: ${reason}`,
    `Failed to request resource metadata: ${reason}`,
    `Could not discover authorization server metadata. Last error: ${reason}`,
    `Could not discover authorization server metadata. https://auth.example/.well-known/oauth-authorization-server failed: ${reason}; https://auth.example/.well-known/openid-configuration failed: ${reason}.`,
    `CIMD metadata fetch failed: ${reason}. Try using 'dcr' or 'preregistered' registration strategy instead.`,
  ])("finds the sentence in %s", (message) => {
    expect(isTlsTrustFailure(message)).toBe(true);
  });

  it("does not match Node's text on its own", () => {
    expect(
      isTlsTrustFailure(
        `Failed to request MCP server: Backend debug proxy error: 500 Internal Server Error: ${LEAF}`
      )
    ).toBe(false);
  });
});

describe("describeError on a certificate failure", () => {
  it("files the route's 502 under the server's certificate", () => {
    const normalized = describeError(
      tlsTrustFailure(nodeTlsError("UNABLE_TO_VERIFY_LEAF_SIGNATURE", LEAF))
    );

    expect(normalized.slug).toBe("transport/tls_untrusted");
    expect(normalized.origin).toBe("user_server");
  });

  // The same codes reach us from MCPJam's own hops (a local inspector calling
  // our cloud through a TLS-inspecting proxy). Only a caller that knows the
  // request went to the server under test may name its certificate.
  it("leaves Node's raw error where it was", () => {
    const normalized = describeError(
      nodeTlsError(
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "unable to get local issuer certificate"
      )
    );

    expect(normalized.slug).not.toBe("transport/tls_untrusted");
    expect(normalized.origin).not.toBe("user_server");
  });
});

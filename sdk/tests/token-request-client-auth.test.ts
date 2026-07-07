import { describe, expect, it } from "vitest";
import {
  buildTokenRequestClientAuth,
  normalizeRegisteredClientAuthMethod,
} from "../src/oauth/state-machines/shared/client-auth.js";

describe("buildTokenRequestClientAuth", () => {
  it("client_secret_basic → Authorization header, empty body params", () => {
    const auth = buildTokenRequestClientAuth({
      clientId: "client_abc",
      clientSecret: "shhh",
      tokenEndpointAuthMethod: "client_secret_basic",
    });

    expect(auth.headers).toEqual({
      Authorization: `Basic ${btoa("client_abc:shhh")}`,
    });
    expect(auth.bodyParams).toEqual({});
  });

  it("form-urlencodes credential parts before base64 (RFC 6749 §2.3.1 / Appendix B)", () => {
    const auth = buildTokenRequestClientAuth({
      clientId: "client:with colon",
      clientSecret: "p@ss wörd+/=!~",
      tokenEndpointAuthMethod: "client_secret_basic",
    });

    // application/x-www-form-urlencoded, NOT encodeURIComponent: space → "+",
    // and "!" / "~" are percent-encoded.
    const formEncode = (v: string) =>
      new URLSearchParams([["v", v]]).toString().slice(2);
    expect(formEncode("p@ss wörd+/=!~")).toContain("+w%C3%B6rd");
    expect(formEncode("p@ss wörd+/=!~")).toContain("%21%7E");

    const expected = `${formEncode("client:with colon")}:${formEncode("p@ss wörd+/=!~")}`;
    expect(auth.headers.Authorization).toBe(`Basic ${btoa(expected)}`);
  });

  it("client_secret_post → id and secret in body params, no header", () => {
    const auth = buildTokenRequestClientAuth({
      clientId: "client_abc",
      clientSecret: "shhh",
      tokenEndpointAuthMethod: "client_secret_post",
    });

    expect(auth.headers).toEqual({});
    expect(auth.bodyParams).toEqual({
      client_id: "client_abc",
      client_secret: "shhh",
    });
  });

  it("none → client_id only; the secret is never transmitted", () => {
    const auth = buildTokenRequestClientAuth({
      clientId: "client_abc",
      clientSecret: "shhh",
      tokenEndpointAuthMethod: "none",
    });

    expect(auth.headers).toEqual({});
    expect(auth.bodyParams).toEqual({ client_id: "client_abc" });
  });

  it("absent method with a secret keeps the legacy body shape (DCR-issued secrets)", () => {
    const auth = buildTokenRequestClientAuth({
      clientId: "client_abc",
      clientSecret: "shhh",
    });

    expect(auth.headers).toEqual({});
    expect(auth.bodyParams).toEqual({
      client_id: "client_abc",
      client_secret: "shhh",
    });
  });

  it("public client without a secret sends only client_id", () => {
    const auth = buildTokenRequestClientAuth({ clientId: "client_abc" });

    expect(auth.headers).toEqual({});
    expect(auth.bodyParams).toEqual({ client_id: "client_abc" });
  });

  it("no credentials at all yields empty header and body params", () => {
    const auth = buildTokenRequestClientAuth({});

    expect(auth.headers).toEqual({});
    expect(auth.bodyParams).toEqual({});
  });
});

describe("normalizeRegisteredClientAuthMethod", () => {
  it("drops a contradictory 'none' when the DCR response issued a secret", () => {
    expect(
      normalizeRegisteredClientAuthMethod({
        client_secret: "shhh",
        token_endpoint_auth_method: "none",
      }),
    ).toBeUndefined();
  });

  it("stores undefined for a secret without an advertised method (legacy body shape)", () => {
    expect(
      normalizeRegisteredClientAuthMethod({ client_secret: "shhh" }),
    ).toBeUndefined();
  });

  it("keeps an explicit method for secret-bearing clients", () => {
    expect(
      normalizeRegisteredClientAuthMethod({
        client_secret: "shhh",
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toBe("client_secret_basic");
  });

  it("defaults public clients to 'none'", () => {
    expect(normalizeRegisteredClientAuthMethod({})).toBe("none");
    expect(
      normalizeRegisteredClientAuthMethod({
        token_endpoint_auth_method: "none",
      }),
    ).toBe("none");
  });
});

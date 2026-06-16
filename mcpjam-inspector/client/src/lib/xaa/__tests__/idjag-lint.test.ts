import { describe, expect, it } from "vitest";
import { lintIdJag, type IdJagLintContext } from "../idjag-lint";

const NOW = 1_750_000_000;

const VALID_HEADER = {
  alg: "RS256",
  typ: "oauth-id-jag+jwt",
  kid: "xaa-idp-1",
};

const VALID_PAYLOAD = {
  iss: "https://idp.example.com",
  sub: "user-12345",
  aud: "https://as.example.com",
  resource: "https://mcp.example.com",
  client_id: "client-abc",
  jti: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
  iat: NOW,
  exp: NOW + 5 * 60,
};

const CONTEXT: IdJagLintContext = {
  expectedIssuer: "https://idp.example.com",
  expectedAudience: "https://as.example.com",
  expectedResource: "https://mcp.example.com",
  expectedClientId: "client-abc",
  nowSeconds: NOW,
};

function verdictFor(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  id: string,
  context: IdJagLintContext = CONTEXT,
) {
  const verdict = lintIdJag(header, payload, context).find((v) => v.id === id);
  if (!verdict) throw new Error(`no verdict for ${id}`);
  return verdict;
}

describe("lintIdJag", () => {
  it("passes every claim on a valid ID-JAG", () => {
    const verdicts = lintIdJag(VALID_HEADER, VALID_PAYLOAD, CONTEXT);
    expect(verdicts).toHaveLength(8);
    expect(verdicts.every((v) => v.status === "pass")).toBe(true);
    expect(verdicts.every((v) => v.citation.spec.length > 0)).toBe(true);
  });

  describe("typ header", () => {
    it("fails a generic JWT typ and cites the explicit-typing BCP", () => {
      const verdict = verdictFor(
        { ...VALID_HEADER, typ: "JWT" },
        VALID_PAYLOAD,
        "typ",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.citation.spec).toBe("RFC 8725");
      expect(verdict.actual).toBe("JWT");
    });

    it("fails a missing typ", () => {
      const { typ: _typ, ...headerWithoutTyp } = VALID_HEADER;
      const verdict = verdictFor(headerWithoutTyp, VALID_PAYLOAD, "typ");
      expect(verdict.status).toBe("fail");
      expect(verdict.actual).toBe("(absent)");
    });
  });

  describe("iss", () => {
    it("fails a wrong issuer against the configured flow", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, iss: "https://wrong-issuer.example.com" },
        "iss",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("https://idp.example.com");
    });

    it("passes presence-only when no expected issuer is configured", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, iss: "https://anything.example.com" },
        "iss",
        { nowSeconds: NOW },
      );
      expect(verdict.status).toBe("pass");
    });

    it("fails a missing issuer", () => {
      const { iss: _iss, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "iss").status).toBe("fail");
    });
  });

  describe("sub", () => {
    it("fails a missing subject", () => {
      const { sub: _sub, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "sub").status).toBe("fail");
    });

    it("fails an empty subject", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, sub: "  " },
        "sub",
      );
      expect(verdict.status).toBe("fail");
    });
  });

  describe("aud", () => {
    it("fails an audience mismatch (exact-match rule)", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, aud: "https://wrong-audience.example.com" },
        "aud",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("exactly match");
    });

    it("fails an array audience", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, aud: ["https://as.example.com"] },
        "aud",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("array");
    });
  });

  describe("resource", () => {
    it("fails a resource mismatch", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, resource: "https://wrong-resource.example.com" },
        "resource",
      );
      expect(verdict.status).toBe("fail");
    });

    it("fails a missing resource", () => {
      const { resource: _resource, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "resource").status).toBe("fail");
    });
  });

  describe("client_id", () => {
    it("fails a client binding mismatch", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, client_id: "wrong-client-id" },
        "client_id",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("client-abc");
    });

    it("fails a missing client_id", () => {
      const { client_id: _clientId, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "client_id").status).toBe(
        "fail",
      );
    });
  });

  describe("jti", () => {
    it("warns when jti is absent (replay detection)", () => {
      const { jti: _jti, ...payload } = VALID_PAYLOAD;
      const verdict = verdictFor(VALID_HEADER, payload, "jti");
      expect(verdict.status).toBe("warn");
      expect(verdict.detail).toContain("replay");
    });
  });

  describe("exp", () => {
    it("fails an expired assertion", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, exp: NOW - 60 },
        "exp",
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("expired");
    });

    it("fails a missing exp", () => {
      const { exp: _exp, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "exp").status).toBe("fail");
    });

    it("warns on an unusually long lifetime", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, exp: NOW + 24 * 60 * 60 },
        "exp",
      );
      expect(verdict.status).toBe("warn");
    });
  });

  it("handles null header and payload without throwing", () => {
    const verdicts = lintIdJag(null, null, { nowSeconds: NOW });
    expect(verdicts).toHaveLength(8);
    expect(verdicts.some((v) => v.status === "pass")).toBe(false);
  });
});

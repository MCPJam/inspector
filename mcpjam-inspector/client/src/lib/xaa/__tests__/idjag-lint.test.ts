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
  email: "user@example.com",
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
  context: IdJagLintContext = CONTEXT
) {
  const verdict = lintIdJag(header, payload, context).find((v) => v.id === id);
  if (!verdict) throw new Error(`no verdict for ${id}`);
  return verdict;
}

describe("lintIdJag", () => {
  it("passes every claim on a valid ID-JAG", () => {
    const verdicts = lintIdJag(VALID_HEADER, VALID_PAYLOAD, CONTEXT);
    expect(verdicts).toHaveLength(10);
    expect(verdicts.every((v) => v.status === "pass")).toBe(true);
    expect(verdicts.every((v) => v.citation.spec.length > 0)).toBe(true);
  });

  describe("typ header", () => {
    it("fails a generic JWT typ and cites the explicit-typing BCP", () => {
      const verdict = verdictFor(
        { ...VALID_HEADER, typ: "JWT" },
        VALID_PAYLOAD,
        "typ"
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
        "iss"
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("https://idp.example.com");
    });

    it("passes presence-only when no expected issuer is configured", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, iss: "https://anything.example.com" },
        "iss",
        { nowSeconds: NOW }
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
        "sub"
      );
      expect(verdict.status).toBe("fail");
    });
  });

  describe("aud", () => {
    it("fails an audience mismatch (exact-match rule)", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, aud: "https://wrong-audience.example.com" },
        "aud"
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("exactly match");
    });

    it("fails an array audience", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, aud: ["https://as.example.com"] },
        "aud"
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
        "resource"
      );
      expect(verdict.status).toBe("fail");
    });

    it("warns for an optional missing resource", () => {
      const { resource: _resource, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "resource").status).toBe("warn");
    });
  });

  describe("client_id", () => {
    it("fails a client binding mismatch", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, client_id: "wrong-client-id" },
        "client_id"
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.detail).toContain("client-abc");
    });

    it("fails a missing client_id", () => {
      const { client_id: _clientId, ...payload } = VALID_PAYLOAD;
      expect(verdictFor(VALID_HEADER, payload, "client_id").status).toBe(
        "fail"
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

  describe("iat", () => {
    it("fails a missing iat (required claim)", () => {
      const { iat: _iat, ...payload } = VALID_PAYLOAD;
      const verdict = verdictFor(VALID_HEADER, payload, "iat");
      expect(verdict.status).toBe("fail");
      expect(verdict.citation.spec).toBe("ID-JAG draft");
    });

    it("warns on an iat in the future (clock skew)", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, iat: NOW + 10 * 60 },
        "iat"
      );
      expect(verdict.status).toBe("warn");
      expect(verdict.detail).toContain("clock skew");
    });

    it("passes a present iat", () => {
      expect(verdictFor(VALID_HEADER, VALID_PAYLOAD, "iat").status).toBe(
        "pass"
      );
    });

    it("renders an out-of-range iat as its raw value instead of throwing", () => {
      // A malformed JWT with an absurd iat must not crash the inspector:
      // new Date(1e19 * 1000).toISOString() would throw a RangeError.
      const hugeIat = 1e19;
      expect(() =>
        lintIdJag(
          VALID_HEADER,
          { ...VALID_PAYLOAD, iat: hugeIat },
          { nowSeconds: NOW }
        )
      ).not.toThrow();
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, iat: hugeIat },
        "iat",
        { nowSeconds: NOW }
      );
      expect(verdict.actual).toBe(String(hugeIat));
    });
  });

  describe("subject resolution (email / aud_sub)", () => {
    it("passes when email is present", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        VALID_PAYLOAD,
        "subject_resolution"
      );
      expect(verdict.status).toBe("pass");
      expect(verdict.actual).toContain("user@example.com");
    });

    it("passes when only aud_sub is present", () => {
      const { email: _email, ...payload } = VALID_PAYLOAD;
      const verdict = verdictFor(
        VALID_HEADER,
        { ...payload, aud_sub: "as-user-42" },
        "subject_resolution"
      );
      expect(verdict.status).toBe("pass");
      expect(verdict.actual).toContain("as-user-42");
    });

    it("warns when neither email nor aud_sub is present", () => {
      const { email: _email, ...payload } = VALID_PAYLOAD;
      const verdict = verdictFor(VALID_HEADER, payload, "subject_resolution");
      expect(verdict.status).toBe("warn");
      expect(verdict.detail).toContain("provisioning");
    });
  });

  describe("exp", () => {
    it("fails an expired assertion", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, exp: NOW - 60 },
        "exp"
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
        "exp"
      );
      expect(verdict.status).toBe("warn");
    });

    it("renders an out-of-range exp as its raw value instead of throwing", () => {
      const hugeExp = 1e19;
      expect(() =>
        lintIdJag(
          VALID_HEADER,
          { ...VALID_PAYLOAD, exp: hugeExp },
          { nowSeconds: NOW }
        )
      ).not.toThrow();
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, exp: hugeExp },
        "exp",
        { nowSeconds: NOW }
      );
      expect(verdict.actual).toBe(String(hugeExp));
    });
  });

  describe("sub_id (structured subject identifier, draft §3.2.2)", () => {
    it("emits NO sub_id row when the claim is absent (OIDC baseline)", () => {
      // Zero regression: an OIDC ID-JAG's verdict list and warn/fail summary
      // must be untouched by the sub_id lint.
      const verdicts = lintIdJag(VALID_HEADER, VALID_PAYLOAD, CONTEXT);
      expect(verdicts.some((v) => v.id === "sub_id")).toBe(false);
      expect(verdicts).toHaveLength(10);
      expect(verdicts.every((v) => v.status === "pass")).toBe(true);
    });

    it("emits a pass row summarizing format/issuer/sp_name_qualifier when present", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        {
          ...VALID_PAYLOAD,
          sub_id: {
            format: "saml-nameid",
            issuer: "https://idp.example.com",
            nameid: "user-12345",
            sp_name_qualifier: "https://as.example.com",
            nameid_format:
              "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
          },
        },
        "sub_id"
      );
      expect(verdict.status).toBe("pass");
      expect(verdict.actual).toBe(
        "format: saml-nameid, issuer: https://idp.example.com, sp_name_qualifier: https://as.example.com"
      );
    });

    it("fails a non-object sub_id (malformed, not resolvable) without throwing", () => {
      const verdict = verdictFor(
        VALID_HEADER,
        { ...VALID_PAYLOAD, sub_id: "opaque" },
        "sub_id"
      );
      expect(verdict.status).toBe("fail");
      expect(verdict.actual).toBe("opaque");
    });

    it("fails a malformed sub_id (null, empty object, wrong format, or missing nameid)", () => {
      const malformed: unknown[] = [
        null,
        {},
        { format: "oauth-sub", issuer: "i", nameid: "n" },
        { format: "saml-nameid", issuer: "i" },
        { format: "saml-nameid", nameid: "n" },
        {
          format: "saml-nameid",
          issuer: "i",
          nameid: "n",
          sp_name_qualifier: 5,
        },
      ];
      for (const sub_id of malformed) {
        const verdict = verdictFor(
          VALID_HEADER,
          { ...VALID_PAYLOAD, sub_id },
          "sub_id"
        );
        expect(verdict.status).toBe("fail");
      }
    });
  });

  it("handles null header and payload without throwing", () => {
    const verdicts = lintIdJag(null, null, { nowSeconds: NOW });
    expect(verdicts).toHaveLength(10);
    expect(verdicts.some((v) => v.status === "pass")).toBe(false);
  });
});

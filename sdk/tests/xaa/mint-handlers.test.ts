import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  handleXaaAuthenticate,
  handleXaaJsonTokenExchange,
  handleXaaTokenExchangeGrant,
} from "../../src/xaa/mint/handlers.js";
import { resetXAAIdpKeyPairForTests } from "../../src/xaa/mint/keypair.js";
import { issueMockIdToken, verifyXaaJwt } from "../../src/xaa/mint/signer.js";
import { decodeJWT } from "../../src/oauth/state-machines/shared/jwt.js";
import {
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_IDP_CLIENT_ID,
} from "../../src/oauth/client-identity.js";

const ISSUER = "https://issuer.example.com/api/mcp/xaa";
const AS_ISSUER = "https://auth.example.com";
const RESOURCE = "https://mcp.example.com/mcp";

describe("shared XAA mint handler cores", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-handlers-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
  });

  describe("handleXaaAuthenticate", () => {
    it("mints a verifiable id_token with the rich response body", () => {
      const result = handleXaaAuthenticate({
        issuer: ISSUER,
        userId: "user-1",
        email: "u@example.com",
        audience: "client-1",
        resourceClientId: "ras-client-1",
      });

      expect(result.status).toBe(200);
      expect(result.body.token_type).toBe("Bearer");
      expect(result.body.expires_in).toBeGreaterThan(0);
      expect(result.body.user).toEqual({
        sub: "user-1",
        email: "u@example.com",
      });
      const claims = verifyXaaJwt(result.body.id_token as string, {
        issuer: ISSUER,
        typ: "JWT",
      });
      expect(claims.sub).toBe("user-1");
      expect(claims.email).toBe("u@example.com");
      expect(claims.aud).toBe("client-1");
    });

    it("falls back to the demo identity when subject/email are absent", () => {
      const result = handleXaaAuthenticate({ issuer: ISSUER });

      expect(result.status).toBe(200);
      expect(result.body.user).toEqual({
        sub: "user-12345",
        email: "demo.user@example.com",
      });
      const claims = decodeJWT(result.body.id_token as string)!;
      expect(claims.sub).toBe("user-12345");
      expect(claims.email).toBe("demo.user@example.com");
    });

    it("falls back to the demo identity on empty strings too", () => {
      const result = handleXaaAuthenticate({
        issuer: ISSUER,
        userId: "",
        email: "",
      });
      expect(result.body.user).toEqual({
        sub: "user-12345",
        email: "demo.user@example.com",
      });
    });
  });

  describe("handleXaaJsonTokenExchange", () => {
    const mintAssertion = (subject: string) =>
      issueMockIdToken({
        issuer: ISSUER,
        subject,
        email: "u@example.com",
      }).token;

    it("mints an ID-JAG with the rich response body", () => {
      const result = handleXaaJsonTokenExchange({
        issuer: ISSUER,
        identityAssertion: mintAssertion("user-1"),
        audience: AS_ISSUER,
        resource: RESOURCE,
        clientId: "client-1",
        scope: "read:tools",
        negativeTestMode: "valid",
      });

      expect(result.status).toBe(200);
      expect(result.body.token_type).toBe("N_A");
      expect(result.body.issued_token_type).toBe(ID_JAG_TOKEN_TYPE);
      expect(result.body.expires_in).toBeGreaterThan(0);
      expect(result.body.negative_test_mode).toBe("valid");
      const claims = verifyXaaJwt(result.body.id_jag as string, {
        issuer: ISSUER,
        typ: "oauth-id-jag+jwt",
      });
      expect(claims).toMatchObject({
        sub: "user-1",
        aud: AS_ISSUER,
        resource: RESOURCE,
        client_id: "client-1",
        scope: "read:tools",
        email: "u@example.com",
      });
    });

    it("applies the negative-test tamper and echoes the mode", () => {
      const result = handleXaaJsonTokenExchange({
        issuer: ISSUER,
        identityAssertion: mintAssertion("user-1"),
        audience: AS_ISSUER,
        clientId: "client-1",
        negativeTestMode: "wrong_audience",
      });

      expect(result.status).toBe(200);
      expect(result.body.negative_test_mode).toBe("wrong_audience");
      expect(decodeJWT(result.body.id_jag as string)!.aud).toBe(
        "https://wrong-audience.example.com"
      );
    });

    it("throws on a non-JWT assertion (adapter maps to 400)", () => {
      expect(() =>
        handleXaaJsonTokenExchange({
          issuer: ISSUER,
          identityAssertion: "not-a-jwt",
          audience: AS_ISSUER,
          clientId: "client-1",
          negativeTestMode: "valid",
        })
      ).toThrow("Identity assertion must be a JWT");
    });

    it("throws on an assertion without a subject", () => {
      expect(() =>
        handleXaaJsonTokenExchange({
          issuer: ISSUER,
          identityAssertion: mintAssertion(""),
          audience: AS_ISSUER,
          clientId: "client-1",
          negativeTestMode: "valid",
        })
      ).toThrow(
        "Identity assertion payload must contain a non-empty `sub` claim"
      );
    });
  });

  describe("handleXaaTokenExchangeGrant", () => {
    const mintSubjectToken = () =>
      issueMockIdToken({
        issuer: ISSUER,
        subject: "user-1",
        email: "u@example.com",
        audience: XAA_DEBUG_IDP_CLIENT_ID,
        resourceClientId: "client-1",
      }).token;

    const validForm = () => ({
      grant_type: TOKEN_EXCHANGE_GRANT,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: mintSubjectToken(),
      subject_token_type: ID_TOKEN_TOKEN_TYPE,
      client_id: XAA_DEBUG_IDP_CLIENT_ID,
      audience: AS_ISSUER,
      resource: RESOURCE,
      scope: "read:tools",
    });

    it("mints an ID-JAG with the rich RFC 8693 response body", () => {
      const result = handleXaaTokenExchangeGrant(ISSUER, validForm());

      expect(result.status).toBe(200);
      expect(result.body.issued_token_type).toBe(ID_JAG_TOKEN_TYPE);
      expect(result.body.token_type).toBe("N_A");
      expect(result.body.expires_in).toBeGreaterThan(0);
      expect(result.body.scope).toBe("read:tools");
      const claims = verifyXaaJwt(result.body.access_token as string, {
        issuer: ISSUER,
        typ: "oauth-id-jag+jwt",
      });
      expect(claims).toMatchObject({
        sub: "user-1",
        aud: AS_ISSUER,
        resource: RESOURCE,
        client_id: "client-1",
        scope: "read:tools",
        email: "u@example.com",
      });
    });

    it("omits scope from the response when the request had none", () => {
      const { scope: _scope, ...form } = validForm();
      const result = handleXaaTokenExchangeGrant(ISSUER, form);
      expect(result.status).toBe(200);
      expect("scope" in result.body).toBe(false);
    });

    it("rejects a wrong requested_token_type with 400 invalid_request", () => {
      const result = handleXaaTokenExchangeGrant(ISSUER, {
        ...validForm(),
        requested_token_type: "urn:example:wrong",
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe(
        `requested_token_type must be ${ID_JAG_TOKEN_TYPE}`
      );
    });

    it("rejects a wrong subject_token_type with 400 invalid_request", () => {
      const result = handleXaaTokenExchangeGrant(ISSUER, {
        ...validForm(),
        subject_token_type: "urn:example:wrong",
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe(
        `subject_token_type must be ${ID_TOKEN_TOKEN_TYPE}`
      );
    });

    it("rejects a missing client_id with 400 invalid_request", () => {
      const { client_id: _clientId, ...form } = validForm();
      const result = handleXaaTokenExchangeGrant(ISSUER, form);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_request");
      expect(result.body.error_description).toBe("client_id is required");
    });

    it("rejects an unknown client_id with 401 invalid_client", () => {
      const result = handleXaaTokenExchangeGrant(ISSUER, {
        ...validForm(),
        client_id: "someone-else",
      });
      expect(result.status).toBe(401);
      expect(result.body.error).toBe("invalid_client");
      expect(result.body.error_description).toBe("Unknown mock IdP client_id");
    });

    it("rejects a missing subject_token/audience with 400 invalid_request", () => {
      for (const field of ["subject_token", "audience"] as const) {
        const form = validForm();
        delete (form as Record<string, string>)[field];
        const result = handleXaaTokenExchangeGrant(ISSUER, form);
        expect(result.status, field).toBe(400);
        expect(result.body.error, field).toBe("invalid_request");
        expect(result.body.error_description, field).toBe(
          "subject_token and audience are required"
        );
      }
    });

    it("rejects a subject token from another issuer with 400 invalid_grant", () => {
      const foreign = issueMockIdToken({
        issuer: "https://other-issuer.example.com/xaa",
        subject: "user-1",
        email: "u@example.com",
        audience: XAA_DEBUG_IDP_CLIENT_ID,
        resourceClientId: "client-1",
      }).token;
      const result = handleXaaTokenExchangeGrant(ISSUER, {
        ...validForm(),
        subject_token: foreign,
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_grant");
    });

    it("rejects a subject token without the RAS client mapping with 400 invalid_grant", () => {
      const unmapped = issueMockIdToken({
        issuer: ISSUER,
        subject: "user-1",
        email: "u@example.com",
        audience: XAA_DEBUG_IDP_CLIENT_ID,
      }).token;
      const result = handleXaaTokenExchangeGrant(ISSUER, {
        ...validForm(),
        subject_token: unmapped,
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_grant");
      expect(result.body.error_description).toBe(
        "The subject token is missing the IdP's RAS client mapping"
      );
    });
  });
});

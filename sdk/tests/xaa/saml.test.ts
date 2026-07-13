import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { SignedXml } from "xml-crypto";
import {
  decodeSamlAssertionSubjectUnsafe,
  issueMockSamlAssertion,
  verifyMockSamlAssertion,
  SAML_NAMEID_FORMAT_PERSISTENT,
} from "../../src/xaa/mint/saml.js";
import {
  getXAAIdpPrivateKey,
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../src/xaa/mint/keypair.js";
import { XAA_RAS_CLIENT_ID_CLAIM } from "../../src/xaa/mint/signer.js";

const ISSUER = "https://issuer.example.com/api/mcp/xaa";
const SP_ENTITY_ID = "mcpjam-xaa-debugger";

const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";
const SHA1_DIGEST = "http://www.w3.org/2000/09/xmldsig#sha1";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const b64 = (xml: string) => Buffer.from(xml, "utf-8").toString("base64");
const fromB64 = (value: string) =>
  Buffer.from(value, "base64").toString("utf-8");

function mint(
  overrides: Partial<Parameters<typeof issueMockSamlAssertion>[0]> = {}
) {
  return issueMockSamlAssertion({
    issuer: ISSUER,
    subject: "user-1",
    email: "u@example.com",
    spEntityId: SP_ENTITY_ID,
    resourceClientId: "ras-client-1",
    ...overrides,
  });
}

/** Hand-rolled assertion template for tamper variants the mint refuses to
 * produce (past windows, missing attributes, duplicate elements, …). */
function rawAssertionXml(options: {
  id?: string;
  issuer?: string;
  nameid?: string;
  audience?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  confirmationNotOnOrAfter?: string;
  confirmationMethod?: string;
  rasClientId?: string | null;
  extraBody?: string;
}): { xml: string; id: string } {
  const id = options.id ?? `_${randomUUID()}`;
  const now = Date.now();
  const notBefore = options.notBefore ?? new Date(now).toISOString();
  const notOnOrAfter =
    options.notOnOrAfter ?? new Date(now + 300000).toISOString();
  const confirmationNotOnOrAfter =
    options.confirmationNotOnOrAfter ?? notOnOrAfter;
  const rasAttribute =
    options.rasClientId === null
      ? ""
      : `<saml:Attribute Name="${XAA_RAS_CLIENT_ID_CLAIM}"><saml:AttributeValue>${
          options.rasClientId ?? "ras-client-1"
        }</saml:AttributeValue></saml:Attribute>`;
  const xml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Version="2.0" ID="${id}" IssueInstant="${notBefore}">` +
    `<saml:Issuer>${options.issuer ?? ISSUER}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${SAML_NAMEID_FORMAT_PERSISTENT}" SPNameQualifier="${
      options.audience ?? SP_ENTITY_ID
    }">${options.nameid ?? "user-1"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${
      options.confirmationMethod ?? "urn:oasis:names:tc:SAML:2.0:cm:bearer"
    }">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${confirmationNotOnOrAfter}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${
      options.audience ?? SP_ENTITY_ID
    }</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>u@example.com</saml:AttributeValue></saml:Attribute>` +
    rasAttribute +
    `</saml:AttributeStatement>` +
    (options.extraBody ?? "") +
    `</saml:Assertion>`;
  return { xml, id };
}

function signRawAssertion(
  xml: string,
  options: {
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
    transforms?: string[];
    privateKeyPem?: string;
  } = {}
): string {
  initXAAIdpKeyPair();
  const signer = new SignedXml({
    privateKey:
      options.privateKeyPem ??
      (getXAAIdpPrivateKey().export({
        type: "pkcs8",
        format: "pem",
      }) as string),
  });
  signer.signatureAlgorithm = (options.signatureAlgorithm ??
    RSA_SHA256) as typeof signer.signatureAlgorithm;
  signer.canonicalizationAlgorithm = EXC_C14N;
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: (options.digestAlgorithm ??
      SHA256_DIGEST) as "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: (options.transforms ?? [
      ENVELOPED,
      EXC_C14N,
    ]) as Array<"http://www.w3.org/2001/10/xml-exc-c14n#">,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
  });
  return signer.getSignedXml();
}

const verify = (assertionB64: string) =>
  verifyMockSamlAssertion(assertionB64, {
    issuer: ISSUER,
    audience: SP_ENTITY_ID,
  });

describe("mock SAML assertion mint + hardened verification", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-saml-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
  });

  it("round-trips: a minted assertion verifies and yields the subject", () => {
    const issued = mint();

    expect(issued.assertionB64).toBe(b64(issued.assertionXml));
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(issued.subject).toEqual({
      issuer: ISSUER,
      nameid: "user-1",
      nameidFormat: SAML_NAMEID_FORMAT_PERSISTENT,
      spNameQualifier: SP_ENTITY_ID,
    });

    const verified = verify(issued.assertionB64);
    expect(verified).toEqual({
      nameid: "user-1",
      nameidFormat: SAML_NAMEID_FORMAT_PERSISTENT,
      spNameQualifier: SP_ENTITY_ID,
      email: "u@example.com",
      resourceClientId: "ras-client-1",
    });
  });

  it("XML-escapes user-controlled subject/email values", () => {
    const hostile = `"><evil>&'`;
    const issued = mint({
      subject: hostile,
      email: `a&b<c>"d"@example.com`,
    });

    // The raw XML must not contain the unescaped injection.
    expect(issued.assertionXml).not.toContain("<evil>");
    const verified = verify(issued.assertionB64);
    expect(verified.nameid).toBe(hostile);
    expect(verified.email).toBe(`a&b<c>"d"@example.com`);
  });

  it("rejects a tampered assertion (broken signature)", () => {
    const issued = mint();
    const tampered = b64(
      fromB64(issued.assertionB64).replace(">user-1<", ">admin<")
    );
    expect(() => verify(tampered)).toThrow(/signature verification failed/i);
  });

  it("rejects an assertion signed by a foreign key", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { xml } = rawAssertionXml({});
    const signed = signRawAssertion(xml, {
      privateKeyPem: pair.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string,
    });
    expect(() => verify(b64(signed))).toThrow(/signature verification failed/i);
  });

  it("rejects an RSA-SHA1 signature (algorithm downgrade)", () => {
    const { xml } = rawAssertionXml({});
    const signed = signRawAssertion(xml, { signatureAlgorithm: RSA_SHA1 });
    expect(() => verify(b64(signed))).toThrow(/SHA-1/);
  });

  it("rejects a SHA-1 digest (algorithm downgrade)", () => {
    const { xml } = rawAssertionXml({});
    const signed = signRawAssertion(xml, { digestAlgorithm: SHA1_DIGEST });
    expect(() => verify(b64(signed))).toThrow(/SHA-1/);
  });

  it("rejects unexpected reference transforms", () => {
    const { xml } = rawAssertionXml({});
    // Missing the enveloped-signature transform.
    const signed = signRawAssertion(xml, { transforms: [EXC_C14N] });
    expect(() => verify(b64(signed))).toThrow(/transforms/i);
  });

  it("rejects an audience mismatch on correctly signed content", () => {
    const issued = mint({ spEntityId: "someone-elses-sp" });
    expect(() => verify(issued.assertionB64)).toThrow(/AudienceRestriction/);
  });

  it("rejects an issuer mismatch on correctly signed content", () => {
    const issued = mint({ issuer: "https://other-issuer.example.com/xaa" });
    expect(() => verify(issued.assertionB64)).toThrow(/issuer mismatch/i);
  });

  it("rejects expired Conditions (beyond the ±60s skew)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 10 * 60 * 1000);
    const issued = mint();
    vi.useRealTimers();
    expect(() => verify(issued.assertionB64)).toThrow(/expired/i);
  });

  it("accepts an assertion just inside the ±60s skew window", () => {
    vi.useFakeTimers();
    // Conditions live 5 minutes; 5m30s ago is expired-by-30s → inside skew.
    vi.setSystemTime(Date.now() - 5.5 * 60 * 1000);
    const issued = mint();
    vi.useRealTimers();
    expect(verify(issued.assertionB64).nameid).toBe("user-1");
  });

  it("rejects a not-yet-valid NotBefore", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    const issued = mint();
    vi.useRealTimers();
    expect(() => verify(issued.assertionB64)).toThrow(/not yet valid/i);
  });

  it("rejects a non-bearer SubjectConfirmation", () => {
    const { xml } = rawAssertionXml({
      confirmationMethod: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key",
    });
    expect(() => verify(b64(signRawAssertion(xml)))).toThrow(/bearer/i);
  });

  it("rejects an expired bearer SubjectConfirmationData", () => {
    const { xml } = rawAssertionXml({
      confirmationNotOnOrAfter: new Date(
        Date.now() - 10 * 60 * 1000
      ).toISOString(),
    });
    expect(() => verify(b64(signRawAssertion(xml)))).toThrow(
      /bearer confirmation has expired/i
    );
  });

  it("rejects a missing RAS-client-id attribute", () => {
    const issued = mint({ resourceClientId: undefined });
    expect(() => verify(issued.assertionB64)).toThrow(/RAS client mapping/);
  });

  it("rejects DOCTYPE/DTD and entity declarations before parsing", () => {
    const issued = mint();
    const withDoctype = b64(
      `<!DOCTYPE saml:Assertion [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
        fromB64(issued.assertionB64)
    );
    expect(() => verify(withDoctype)).toThrow(/DOCTYPE|entity/i);
    expect(() => decodeSamlAssertionSubjectUnsafe(withDoctype)).toThrow(
      /DOCTYPE|entity/i
    );
  });

  it("rejects oversized input before decoding", () => {
    const oversized = "A".repeat(100 * 1024);
    expect(() => verify(oversized)).toThrow(/maximum accepted size/i);
    expect(() => decodeSamlAssertionSubjectUnsafe(oversized)).toThrow(
      /maximum accepted size/i
    );
  });

  it("rejects duplicate Assertion elements (wrapped assertions)", () => {
    const issued = mint();
    const { xml: evil } = rawAssertionXml({ nameid: "attacker" });
    const wrapped = b64(
      `<wrapper>${evil}${fromB64(issued.assertionB64)}</wrapper>`
    );
    expect(() => verify(wrapped)).toThrow(/exactly one Assertion/);
  });

  it("rejects duplicate Subject elements before touching the signature", () => {
    const issued = mint();
    // Injecting a second Subject breaks the digest too, but the structural
    // gate must fire FIRST — parsing order is part of the contract.
    const doubled = b64(
      fromB64(issued.assertionB64).replace(
        "<saml:Conditions",
        `<saml:Subject><saml:NameID>attacker</saml:NameID></saml:Subject><saml:Conditions`
      )
    );
    expect(() => verify(doubled)).toThrow(/exactly one (Subject|NameID)/);
  });

  it("rejects a signature-wrapping attempt: attacker assertion + stolen signature referencing the original", () => {
    const issued = mint();
    const originalXml = fromB64(issued.assertionB64);
    const signatureXml = originalXml.slice(
      originalXml.indexOf("<ds:Signature"),
      originalXml.indexOf("</ds:Signature>") + "</ds:Signature>".length
    );
    expect(signatureXml).toContain("<ds:Signature");
    // Attacker assertion (evil claims) carrying the original signature, with
    // the originally signed assertion smuggled alongside so the reference
    // still resolves.
    const { xml: evilXml } = rawAssertionXml({ nameid: "attacker" });
    const evilWithSignature = evilXml.replace(
      "</saml:Issuer>",
      `</saml:Issuer>${signatureXml}`
    );
    const wrapped = b64(
      `<wrapper>${evilWithSignature}${originalXml}</wrapper>`
    );
    expect(() => verify(wrapped)).toThrow(/exactly one (Assertion|Signature)/);
  });

  it("rejects a signature whose reference does not match the Assertion ID", () => {
    const issued = mint();
    const originalXml = fromB64(issued.assertionB64);
    const idMatch = originalXml.match(/ID="(_[^"]+)"/);
    expect(idMatch).not.toBeNull();
    // Renaming the assertion ID orphans the signature's reference URI.
    const renamed = b64(
      originalXml.replace(`ID="${idMatch![1]}"`, `ID="_attacker-id"`)
    );
    expect(() => verify(renamed)).toThrow(
      /signature verification failed|does not match the Assertion ID/i
    );
  });

  it("parses claims from the SIGNED content, never the pre-verification DOM (comment splitting)", () => {
    const issued = mint();
    // Exclusive C14N strips comments, so injecting one inside the NameID text
    // does NOT break the signature — but a naive first-text-node read on the
    // unverified DOM would now return the truncated "user-". The verifier
    // must return the canonical signed value.
    const commented = fromB64(issued.assertionB64).replace(
      ">user-1<",
      ">user-<!--evil-->1<"
    );
    const verified = verify(b64(commented));
    expect(verified.nameid).toBe("user-1");
  });

  describe("decodeSamlAssertionSubjectUnsafe", () => {
    it("decodes subject fields without signature enforcement", () => {
      const { xml } = rawAssertionXml({ nameid: "user-9" });
      // Never signed at all — the lenient path tolerates that.
      const decoded = decodeSamlAssertionSubjectUnsafe(b64(xml));
      expect(decoded).toEqual({
        issuer: ISSUER,
        nameid: "user-9",
        nameidFormat: SAML_NAMEID_FORMAT_PERSISTENT,
        spNameQualifier: SP_ENTITY_ID,
        email: "u@example.com",
        resourceClientId: "ras-client-1",
      });
    });

    it("throws on non-SAML input", () => {
      expect(() => decodeSamlAssertionSubjectUnsafe(b64("not xml"))).toThrow(
        /must be a SAML assertion/
      );
      expect(() =>
        decodeSamlAssertionSubjectUnsafe(b64("<other-root/>"))
      ).toThrow(/must be a SAML assertion/);
    });
  });
});

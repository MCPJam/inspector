// Mock-IdP SAML 2.0 assertion mint + hardened validator (draft-ietf-oauth-
// identity-assertion-authz-grant-04 §4.3 input axis). Node-only — xml-crypto
// pulls in crypto — so this module is exported from the node barrel and MUST
// never be re-exported from the browser entry.
//
// Error messages here describe the failed check but never echo assertion
// content: assertions are credentials and must stay out of logs.
import { randomUUID } from "crypto";
import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import {
  getXAAIdpPrivateKey,
  getXAAIdpPublicKeyObject,
  initXAAIdpKeyPair,
} from "./keypair.js";
import { XAA_RAS_CLIENT_ID_CLAIM } from "./signer.js";

const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

// The only algorithms this mock ever mints or accepts. xml-crypto still
// enables SHA-1 by default, so the validator allowlists rather than trusting
// the library's defaults.
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE =
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export const SAML_NAMEID_FORMAT_PERSISTENT =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const SAML_BEARER_METHOD = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SAML_EMAIL_ATTRIBUTE = "email";

// Matches the mock ID-token TTL so both assertion formats age identically.
const SAML_ASSERTION_TTL_S = 5 * 60;
// Validation clock-skew tolerance on the Conditions window.
const CLOCK_SKEW_S = 60;
// Size cap applied BEFORE base64 decode / XML parse on every entry point
// (strict and lenient): parsing attacker-sized XML is itself the risk.
const MAX_SAML_ASSERTION_BYTES = 64 * 1024;

export interface SamlAssertionSubject {
  issuer: string;
  nameid: string;
  nameidFormat: string;
  spNameQualifier: string;
}

export interface IssueMockSamlAssertionParams {
  /** Mock IdP issuer URL — doubles as its SAML entity ID. */
  issuer: string;
  /** Stable per-user subject; becomes the NameID text. */
  subject: string;
  email: string;
  /**
   * The requesting client's SAML SP entity ID: the AudienceRestriction and
   * the NameID SPNameQualifier. In the mock this is the debug IdP client id.
   */
  spEntityId: string;
  /** Mock-only signed mapping for the RAS client that receives the ID-JAG —
   * the SAML analog of the ID token's XAA_RAS_CLIENT_ID_CLAIM. */
  resourceClientId?: string;
}

export interface IssuedMockSamlAssertion {
  assertionXml: string;
  /** Wire form: base64 of the signed XML. */
  assertionB64: string;
  subject: SamlAssertionSubject;
  expiresAt: number;
}

/** Escape a user-controlled string for use in XML text or attribute values. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Mint a signed SAML 2.0 bearer assertion with the xaa-idp-1 RS256 keypair:
 * enveloped signature (RSA-SHA256, exclusive C14N, SHA-256 digest, single
 * reference to the Assertion ID). Every interpolated value is XML-escaped —
 * subject and email are user-controlled strings.
 */
export function issueMockSamlAssertion(
  params: IssueMockSamlAssertionParams
): IssuedMockSamlAssertion {
  initXAAIdpKeyPair();

  const assertionId = `_${randomUUID()}`;
  const nowMs = Date.now();
  const issueInstant = new Date(nowMs).toISOString();
  const notOnOrAfter = new Date(
    nowMs + SAML_ASSERTION_TTL_S * 1000
  ).toISOString();

  const issuer = escapeXml(params.issuer);
  const nameid = escapeXml(params.subject);
  const email = escapeXml(params.email);
  const spEntityId = escapeXml(params.spEntityId);

  const attributeXml = (name: string, value: string) =>
    `<saml:Attribute Name="${escapeXml(name)}">` +
    `<saml:AttributeValue>${value}</saml:AttributeValue>` +
    `</saml:Attribute>`;

  const assertionXml =
    `<saml:Assertion xmlns:saml="${SAML_ASSERTION_NS}" Version="2.0" ` +
    `ID="${assertionId}" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${SAML_NAMEID_FORMAT_PERSISTENT}" ` +
    `SPNameQualifier="${spEntityId}">${nameid}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${SAML_BEARER_METHOD}">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${issueInstant}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction>` +
    `<saml:Audience>${spEntityId}</saml:Audience>` +
    `</saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}">` +
    `<saml:AuthnContext>` +
    `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
    `</saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    attributeXml(SAML_EMAIL_ATTRIBUTE, email) +
    (params.resourceClientId
      ? attributeXml(
          XAA_RAS_CLIENT_ID_CLAIM,
          escapeXml(params.resourceClientId)
        )
      : "") +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  const signer = new SignedXml({
    privateKey: getXAAIdpPrivateKey().export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  });
  signer.signatureAlgorithm = RSA_SHA256;
  signer.canonicalizationAlgorithm = EXC_C14N;
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: SHA256_DIGEST,
    transforms: [ENVELOPED_SIGNATURE, EXC_C14N],
  });
  // SAML core 2.0 §5.4: ds:Signature follows saml:Issuer.
  signer.computeSignature(assertionXml, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
  });
  const signedXml = signer.getSignedXml();

  return {
    assertionXml: signedXml,
    assertionB64: Buffer.from(signedXml, "utf-8").toString("base64"),
    subject: {
      issuer: params.issuer,
      nameid: params.subject,
      nameidFormat: SAML_NAMEID_FORMAT_PERSISTENT,
      spNameQualifier: params.spEntityId,
    },
    expiresAt: nowMs + SAML_ASSERTION_TTL_S * 1000,
  };
}

export interface VerifyMockSamlAssertionExpectations {
  /** Exact Issuer the assertion must carry. */
  issuer: string;
  /**
   * SP entity ID the AudienceRestriction must include. The IdP maps the
   * authenticated OAuth client_id to this via its client registration; in the
   * mock both are the debug client id, but the mapping is a lookup, not an
   * equality between unrelated identifiers.
   */
  audience: string;
}

export interface VerifiedSamlAssertionSubject {
  nameid: string;
  nameidFormat?: string;
  spNameQualifier?: string;
  email?: string;
  resourceClientId: string;
}

/** Guard shared by the strict and lenient paths: cap size BEFORE decoding or
 * parsing, and reject any DTD/entity machinery outright. */
function decodeGuardedAssertionXml(assertionB64: string): string {
  if (typeof assertionB64 !== "string" || assertionB64.length === 0) {
    throw new Error("SAML assertion must be a non-empty base64 string");
  }
  // The base64 form is ~4/3 the XML size; capping it first keeps oversized
  // input from ever being decoded.
  if (assertionB64.length > (MAX_SAML_ASSERTION_BYTES * 4) / 3 + 4) {
    throw new Error("SAML assertion exceeds the maximum accepted size");
  }
  const xml = Buffer.from(assertionB64, "base64").toString("utf-8");
  if (Buffer.byteLength(xml, "utf-8") > MAX_SAML_ASSERTION_BYTES) {
    throw new Error("SAML assertion exceeds the maximum accepted size");
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error(
      "SAML assertion contains a DOCTYPE/DTD or entity declaration"
    );
  }
  return xml;
}

function parseXmlStrict(xml: string): Document {
  let parseError: string | undefined;
  const recordError = (message: string) => {
    if (!parseError) parseError = message;
  };
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: recordError,
      fatalError: recordError,
    },
  }).parseFromString(xml, "text/xml");
  if (parseError || !doc || !doc.documentElement) {
    // The parser's message can quote document content — report only the fact.
    throw new Error("SAML assertion is not well-formed XML");
  }
  return doc;
}

function selectElements(
  contextNode: Node,
  localName: string,
  namespaceUri: string
): Element[] {
  return xpath.select(
    `//*[local-name(.)='${localName}' and namespace-uri(.)='${namespaceUri}']`,
    contextNode
  ) as Element[];
}

function selectExactlyOne(
  contextNode: Node,
  localName: string,
  namespaceUri: string
): Element {
  const nodes = selectElements(contextNode, localName, namespaceUri);
  if (nodes.length !== 1) {
    throw new Error(
      `SAML assertion must contain exactly one ${localName} element (found ${nodes.length})`
    );
  }
  return nodes[0];
}

function attr(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  return value === null || value === "" ? undefined : value;
}

function text(element: Element): string {
  return (element.textContent ?? "").trim();
}

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`SAML assertion ${label} is not a valid timestamp`);
  }
  return parsed;
}

/** Attribute lookup on the SIGNED document only. */
function findAttributeValue(
  signedAssertion: Element,
  name: string
): string | undefined {
  const attributes = selectElements(
    signedAssertion,
    "Attribute",
    SAML_ASSERTION_NS
  );
  for (const attribute of attributes) {
    if (attribute.getAttribute("Name") !== name) continue;
    const values = xpath.select(
      `./*[local-name(.)='AttributeValue' and namespace-uri(.)='${SAML_ASSERTION_NS}']`,
      attribute
    ) as Element[];
    if (values.length > 0) {
      const value = text(values[0]);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Strict verification of a mock-minted SAML assertion — the hardened
 * contract, in order:
 *
 *  1. Size cap before base64-decode/parse; reject DOCTYPE/DTD/entities.
 *  2. Exactly one Assertion/Signature/Subject/Conditions (plus Issuer and
 *     NameID) — duplicate elements are how wrapped assertions smuggle a
 *     second identity past the signature.
 *  3. Algorithm allowlist BEFORE verifying: rsa-sha256 signature, sha256
 *     digest, exclusive C14N, enveloped-signature + exc-c14n transforms only.
 *     SHA-1 is explicitly rejected — xml-crypto accepts it by default.
 *  4. Signature against the pinned IdP key, then assert the verified
 *     reference URI matches the Assertion ID (signature-wrapping defense).
 *  5. Claims are parsed EXCLUSIVELY from getSignedReferences() output —
 *     xml-crypto's verification guidance treats the pre-verification DOM as
 *     untrusted even after checkSignature succeeds.
 *  6. On the signed content: Issuer match, Conditions window (±60s skew),
 *     AudienceRestriction, bearer SubjectConfirmation with a valid
 *     NotOnOrAfter, non-empty NameID, and the signed RAS-client-id attribute.
 *
 * Throws on any failure; returns the extracted subject on success.
 */
export function verifyMockSamlAssertion(
  assertionB64: string,
  expected: VerifyMockSamlAssertionExpectations
): VerifiedSamlAssertionSubject {
  initXAAIdpKeyPair();

  // Step 1 — size cap + DTD rejection before any decode/parse.
  const xml = decodeGuardedAssertionXml(assertionB64);

  // Step 2 — structural exactly-one gates on the (untrusted) document.
  const doc = parseXmlStrict(xml);
  const assertionElement = selectExactlyOne(
    doc,
    "Assertion",
    SAML_ASSERTION_NS
  );
  const signatureElement = selectExactlyOne(doc, "Signature", XMLDSIG_NS);
  selectExactlyOne(doc, "Subject", SAML_ASSERTION_NS);
  selectExactlyOne(doc, "Conditions", SAML_ASSERTION_NS);
  selectExactlyOne(doc, "Issuer", SAML_ASSERTION_NS);
  selectExactlyOne(doc, "NameID", SAML_ASSERTION_NS);
  const assertionId = attr(assertionElement, "ID");
  if (!assertionId) {
    throw new Error("SAML assertion is missing its ID attribute");
  }

  // Step 3 — algorithm allowlist before any signature math.
  const verifier = new SignedXml({
    publicCert: getXAAIdpPublicKeyObject().export({
      type: "spki",
      format: "pem",
    }) as string,
  });
  verifier.loadSignature(signatureElement);

  const rejectSha1 = (algorithm: string | undefined, label: string) => {
    if (algorithm && /sha-?1(?![0-9])/i.test(algorithm)) {
      throw new Error(`SAML assertion uses SHA-1 for its ${label}, rejected`);
    }
  };
  rejectSha1(verifier.signatureAlgorithm, "signature algorithm");
  if (verifier.signatureAlgorithm !== RSA_SHA256) {
    throw new Error("SAML assertion signature algorithm is not rsa-sha256");
  }
  if (verifier.canonicalizationAlgorithm !== EXC_C14N) {
    throw new Error("SAML assertion canonicalization is not exclusive C14N");
  }
  const references = verifier.getReferences();
  if (references.length !== 1) {
    throw new Error(
      `SAML assertion signature must cover exactly one reference (found ${references.length})`
    );
  }
  const reference = references[0];
  rejectSha1(reference.digestAlgorithm, "digest algorithm");
  if (reference.digestAlgorithm !== SHA256_DIGEST) {
    throw new Error("SAML assertion digest algorithm is not sha256");
  }
  const transforms = reference.transforms ?? [];
  for (const transform of transforms) rejectSha1(transform, "transform");
  if (
    transforms.length !== 2 ||
    !transforms.includes(ENVELOPED_SIGNATURE) ||
    !transforms.includes(EXC_C14N)
  ) {
    throw new Error(
      "SAML assertion reference transforms must be exactly enveloped-signature + exclusive C14N"
    );
  }

  // Step 4 — verify against the pinned key; then pin the verified reference
  // to the Assertion ID so a signature lifted from elsewhere in the document
  // can never vouch for this assertion.
  let signatureValid = false;
  try {
    signatureValid = verifier.checkSignature(xml);
  } catch (error) {
    throw new Error(
      `SAML assertion signature verification failed (${
        error instanceof Error ? error.message : "unknown error"
      })`
    );
  }
  if (!signatureValid) {
    throw new Error("SAML assertion signature verification failed");
  }
  const referenceUri = (reference.uri ?? "").replace(/^#/, "");
  if (!referenceUri || referenceUri !== assertionId) {
    throw new Error(
      "SAML assertion signature reference does not match the Assertion ID"
    );
  }

  // Step 5 — from here on, ONLY the cryptographically verified content is
  // read. getSignedReferences() returns the canonicalized bytes the digest
  // actually covered; the original DOM is untrusted.
  const signedReferences = verifier.getSignedReferences();
  if (signedReferences.length !== 1) {
    throw new Error(
      "SAML assertion verification did not yield exactly one signed reference"
    );
  }
  const signedDoc = parseXmlStrict(signedReferences[0]);
  const signedRoot = signedDoc.documentElement;
  if (
    signedRoot.localName !== "Assertion" ||
    signedRoot.namespaceURI !== SAML_ASSERTION_NS ||
    attr(signedRoot, "ID") !== assertionId
  ) {
    throw new Error(
      "SAML assertion signed content is not the referenced Assertion"
    );
  }

  // Step 6 — claim checks on the signed content.
  const signedIssuer = selectExactlyOne(signedDoc, "Issuer", SAML_ASSERTION_NS);
  if (text(signedIssuer) !== expected.issuer) {
    throw new Error("SAML assertion issuer mismatch");
  }

  const now = Date.now();
  const skewMs = CLOCK_SKEW_S * 1000;
  const conditions = selectExactlyOne(
    signedDoc,
    "Conditions",
    SAML_ASSERTION_NS
  );
  const notBeforeRaw = attr(conditions, "NotBefore");
  const notOnOrAfterRaw = attr(conditions, "NotOnOrAfter");
  if (!notBeforeRaw || !notOnOrAfterRaw) {
    throw new Error("SAML assertion Conditions must bound a validity window");
  }
  if (now + skewMs < parseInstant(notBeforeRaw, "NotBefore")) {
    throw new Error("SAML assertion is not yet valid");
  }
  if (now - skewMs >= parseInstant(notOnOrAfterRaw, "NotOnOrAfter")) {
    throw new Error("SAML assertion has expired");
  }

  const audiences = selectElements(
    conditions,
    "Audience",
    SAML_ASSERTION_NS
  ).map(text);
  if (!audiences.includes(expected.audience)) {
    throw new Error(
      "SAML assertion AudienceRestriction does not include the client's SP entity ID"
    );
  }

  const subjectConfirmation = selectExactlyOne(
    signedDoc,
    "SubjectConfirmation",
    SAML_ASSERTION_NS
  );
  if (attr(subjectConfirmation, "Method") !== SAML_BEARER_METHOD) {
    throw new Error("SAML assertion SubjectConfirmation is not bearer");
  }
  const confirmationData = selectExactlyOne(
    signedDoc,
    "SubjectConfirmationData",
    SAML_ASSERTION_NS
  );
  const confirmationNotOnOrAfter = attr(confirmationData, "NotOnOrAfter");
  if (
    !confirmationNotOnOrAfter ||
    now - skewMs >=
      parseInstant(
        confirmationNotOnOrAfter,
        "SubjectConfirmationData NotOnOrAfter"
      )
  ) {
    throw new Error("SAML assertion bearer confirmation has expired");
  }

  const nameIdElement = selectExactlyOne(
    signedDoc,
    "NameID",
    SAML_ASSERTION_NS
  );
  const nameid = text(nameIdElement);
  if (!nameid) {
    throw new Error("SAML assertion NameID must be non-empty");
  }

  const resourceClientId = findAttributeValue(
    signedRoot,
    XAA_RAS_CLIENT_ID_CLAIM
  );
  if (!resourceClientId) {
    // Mirrors validateXaaTokenExchangeSubject: without the IdP's signed
    // RAS-client mapping there is no client identity to mint into the ID-JAG.
    throw new Error(
      "The subject assertion is missing the IdP's RAS client mapping"
    );
  }

  const email = findAttributeValue(signedRoot, SAML_EMAIL_ATTRIBUTE);

  return {
    nameid,
    nameidFormat: attr(nameIdElement, "Format"),
    spNameQualifier: attr(nameIdElement, "SPNameQualifier"),
    ...(email ? { email } : {}),
    resourceClientId,
  };
}

export interface UnsafeSamlAssertionSubject {
  issuer?: string;
  nameid: string;
  nameidFormat?: string;
  spNameQualifier?: string;
  email?: string;
  resourceClientId?: string;
}

/**
 * Lenient subject extraction for the forgiving JSON mint route — NO signature
 * enforcement (that route exists to mint deliberately broken assertions), but
 * still size-capped and DTD-rejecting: "lenient" means unsigned input is
 * tolerated, never that parsing is unguarded. The SAML analog of
 * decodeJwtPayloadUnsafe.
 */
export function decodeSamlAssertionSubjectUnsafe(
  assertionB64: string
): UnsafeSamlAssertionSubject {
  const xml = decodeGuardedAssertionXml(assertionB64);

  let doc: Document;
  try {
    doc = parseXmlStrict(xml);
  } catch {
    throw new Error("Identity assertion must be a SAML assertion");
  }
  const assertions = selectElements(doc, "Assertion", SAML_ASSERTION_NS);
  if (assertions.length === 0) {
    throw new Error("Identity assertion must be a SAML assertion");
  }
  const assertion = assertions[0];

  const issuers = selectElements(assertion, "Issuer", SAML_ASSERTION_NS);
  const nameIds = selectElements(assertion, "NameID", SAML_ASSERTION_NS);
  const nameIdElement = nameIds.length > 0 ? nameIds[0] : undefined;
  const email = findAttributeValue(assertion, SAML_EMAIL_ATTRIBUTE);
  const resourceClientId = findAttributeValue(
    assertion,
    XAA_RAS_CLIENT_ID_CLAIM
  );

  return {
    ...(issuers.length > 0 && text(issuers[0])
      ? { issuer: text(issuers[0]) }
      : {}),
    nameid: nameIdElement ? text(nameIdElement) : "",
    ...(nameIdElement && attr(nameIdElement, "Format")
      ? { nameidFormat: attr(nameIdElement, "Format") }
      : {}),
    ...(nameIdElement && attr(nameIdElement, "SPNameQualifier")
      ? { spNameQualifier: attr(nameIdElement, "SPNameQualifier") }
      : {}),
    ...(email ? { email } : {}),
    ...(resourceClientId ? { resourceClientId } : {}),
  };
}

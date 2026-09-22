/**
 * Pin the XAA diagnostic-redaction key list.
 *
 * `sanitizeDiagnosticUpdates` redacts secrets out of a state update and writes
 * the result back into LIVE flow state. That is structurally the #3865 OAuth
 * bug: there, a redacted `access_token` remained a non-empty string, passed
 * every truthiness check, and went upstream as a credential.
 *
 * It is inert in XAA today for one reason only — every redacted key is a
 * display surface, and the single value ever read back as behavior
 * (`lastResponse.body.status`) is a number the redactor leaves alone. Adding a
 * credential-bearing key to the list would recreate the bug exactly.
 *
 * So the list is pinned. This test is not asserting that the current five keys
 * are the right five; it is making a widening of the list impossible to do
 * without noticing.
 */

import { REDACTED_DIAGNOSTIC_KEYS } from "../../src/xaa/state-machines/state-machine.js";

/** Fields the XAA flow CONSUMES. None may be redacted in place. */
const CONSUMED_CREDENTIAL_FIELDS = [
  "clientSecret",
  "identityAssertion",
  "idJag",
  "accessToken",
  "refreshToken",
  "codeVerifier",
  "clientId",
  "authorizationCode",
];

describe("XAA diagnostic redaction", () => {
  it("redacts exactly the known display surfaces", () => {
    expect([...REDACTED_DIAGNOSTIC_KEYS]).toEqual([
      "lastRequest",
      "lastResponse",
      "httpHistory",
      "infoLogs",
      "error",
    ]);
  });

  it("never redacts a field the flow consumes", () => {
    for (const field of CONSUMED_CREDENTIAL_FIELDS) {
      expect(
        (REDACTED_DIAGNOSTIC_KEYS as readonly string[]).includes(field),
        `${field} is consumed as live data and must not be redacted in place`,
      ).toBe(false);
    }
  });
});

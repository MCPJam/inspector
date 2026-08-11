/**
 * `state` is a secret in a sanitized trace.
 *
 * It is not a bearer credential, which is why it was easy to leave out: it
 * travels in an authorization URL the user's own browser follows. But a
 * still-live `state` is the CSRF correlation secret for an in-flight
 * authorization — OAuth Security BCP treats its disclosure as loss of that
 * protection — and a trace is persisted, copied, and (hosted) shipped, which
 * the URL is not.
 *
 * The client's sensitive-field set already included `state`; the SDK's did not,
 * so the same value was published or redacted depending on which code path
 * rendered it. There is now one set.
 */

import { projectOAuthTraceSnapshot } from "../../src/oauth/state-machines/trace.js";
import {
  OAUTH_TRACE_SENSITIVE_FIELD_NAMES,
  describeOAuthStateMatch,
  sanitizeOAuthTraceValue,
  sanitizeOAuthUrl,
  sanitizeTraceErrorMessage,
} from "../../src/oauth/state-machines/trace-redaction.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

const NONCE = "JxTSP0zTDfQmyhJ1QcH8b2pKcaKQ2Fq7";

describe("OAuth `state` is redacted everywhere a trace can carry it", () => {
  it("is in the sensitive-field policy", () => {
    expect(OAUTH_TRACE_SENSITIVE_FIELD_NAMES.has("state")).toBe(true);
  });

  it("is redacted as a structured field", () => {
    const sanitized = JSON.stringify(
      sanitizeOAuthTraceValue({ state: NONCE, grant_type: "authorization_code" }),
    );
    expect(sanitized).not.toContain(NONCE);
    // Non-secret siblings survive: the redaction is by field, not wholesale.
    expect(sanitized).toContain("authorization_code");
  });

  it("is redacted in a URL query", () => {
    const sanitized = sanitizeOAuthUrl(
      `https://auth.example.com/authorize?client_id=abc&state=${NONCE}&scope=openid`,
    );
    expect(sanitized).not.toContain(NONCE);
    expect(sanitized).toContain("client_id=abc");
  });

  it("is redacted in a form-encoded body", () => {
    const sanitized = JSON.stringify(
      sanitizeOAuthTraceValue(
        `grant_type=authorization_code&state=${NONCE}&redirect_uri=http%3A%2F%2Flocalhost`,
      ),
    );
    expect(sanitized).not.toContain(NONCE);
  });

  it("is redacted in a JSON body", () => {
    const sanitized = JSON.stringify(
      sanitizeOAuthTraceValue(JSON.stringify({ state: NONCE, iss: "https://a" })),
    );
    expect(sanitized).not.toContain(NONCE);
  });

  it("is redacted inside a free-form error string", () => {
    const sanitized = sanitizeTraceErrorMessage(
      `Callback rejected: state=${NONCE} did not match`,
    );
    expect(sanitized).not.toContain(NONCE);
    expect(sanitized).toContain("state=[redacted]");
    expect(sanitized).toContain("did not match");
  });

  it("never reaches a projected snapshot", () => {
    const snapshot = projectOAuthTraceSnapshot({
      sanitize: true,
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "authorization_request",
        state: NONCE,
        authorizationUrl: `https://auth.example.com/authorize?state=${NONCE}`,
        httpHistory: [
          {
            step: "authorization_request",
            timestamp: 1_000,
            request: {
              method: "GET",
              url: `https://auth.example.com/authorize?state=${NONCE}`,
              headers: {},
            },
          },
        ],
        infoLogs: [],
      } as never,
    });

    expect(JSON.stringify(snapshot)).not.toContain(NONCE);
  });
});

describe("state diagnostics without the nonce", () => {
  it("reports presence and match", () => {
    expect(
      describeOAuthStateMatch({ issuedState: NONCE, callbackState: NONCE }),
    ).toEqual({ statePresent: true, stateMatched: true });

    expect(
      describeOAuthStateMatch({ issuedState: NONCE, callbackState: "other" }),
    ).toEqual({ statePresent: true, stateMatched: false });

    expect(
      describeOAuthStateMatch({ issuedState: NONCE, callbackState: null }),
    ).toEqual({ statePresent: false, stateMatched: false });
  });

  it("omits the verdict when there is nothing to compare against", () => {
    expect(
      describeOAuthStateMatch({ issuedState: undefined, callbackState: NONCE }),
    ).toEqual({ statePresent: true });
  });

  it("carries no state value in its output", () => {
    const serialized = JSON.stringify(
      describeOAuthStateMatch({ issuedState: NONCE, callbackState: NONCE }),
    );
    expect(serialized).not.toContain(NONCE);
  });
});

describe("the redactor preserves diagnostic vocabulary", () => {
  it("keeps the word `token` in an expiry message", () => {
    const snapshot = projectOAuthTraceSnapshot({
      sanitize: true,
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "token_request",
        error: "Bearer token is expired",
        httpHistory: [],
        infoLogs: [],
      },
    });

    expect(snapshot.error).toBe("Bearer token is expired");
  });

  // The reason this needs a test: `URLSearchParams` never fails, so prose
  // containing an `=` used to be reshaped into a single field whose key
  // ("rejected: access_token") is not in the sensitive set — losing the
  // redaction the plain-string path would have applied.
  it("does not lose redaction by reshaping prose into fields", () => {
    const sanitized = JSON.stringify(
      sanitizeOAuthTraceValue(
        "rejected: access_token=ntn_supersecretaccesstokenvalue1234567890",
      ),
    );
    expect(sanitized).not.toContain("ntn_supersecretaccesstokenvalue1234567890");
  });

  it("still renders a real form body as fields", () => {
    expect(
      sanitizeOAuthTraceValue("grant_type=authorization_code&code=abc123xyz789"),
    ).toMatchObject({ grant_type: "authorization_code" });
  });
});

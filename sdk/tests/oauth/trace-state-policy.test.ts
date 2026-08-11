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

describe("shapes a name-only or exact-match policy used to miss", () => {
  const SECRET = "ntn_supersecretvalue1234567890";

  // `new URL(...).toString()` re-emits userinfo, so the parse-success branch of
  // `sanitizeOAuthUrl` shipped `https://user:pass@host` into every sanitized
  // history entry. Only the unparseable branch was covered.
  it("strips userinfo from a parseable URL", () => {
    const sanitized = sanitizeOAuthUrl(
      `https://svc-user:${SECRET}@auth.example.com/token?grant_type=x`,
    );
    expect(sanitized).not.toContain(SECRET);
    expect(sanitized).not.toContain("svc-user");
    expect(sanitized).toContain("auth.example.com/token");
    expect(sanitized).toContain("grant_type=x");
  });

  // Headers and query params applied a `token|secret|auth` heuristic; structured
  // fields applied only the exact-name set. The same name was therefore
  // redacted in a URL and emitted raw in a JSON body.
  it.each(["session_token", "vendor_secret", "x_api_key", "auth"])(
    "redacts %s wherever it appears",
    (name) => {
      expect(
        JSON.stringify(sanitizeOAuthTraceValue({ [name]: SECRET })),
      ).not.toContain(SECRET);
      expect(
        sanitizeOAuthUrl(`https://a.example.com/x?${name}=${SECRET}`),
      ).not.toContain(SECRET);
    },
  );

  // …but the heuristic must not empty out the discovery view. These name a
  // capability; none of them is a value anyone can spend.
  it("keeps protocol metadata that merely describes a credential", () => {
    const metadata = {
      token_type: "Bearer",
      token_endpoint: "https://auth.example.com/token",
      token_endpoint_auth_methods_supported: ["none"],
      id_token_signing_alg_values_supported: ["RS256"],
      revocation_endpoint_auth_methods_supported: ["none"],
      expires_in: 3600,
    };

    expect(sanitizeOAuthTraceValue(metadata)).toEqual(metadata);
  });

  // `URLSearchParams` accepts a colon in a key, so prose parsed as one
  // "structured field" whose name is in no sensitive set.
  it("does not let a colon-bearing key smuggle prose past redaction", () => {
    expect(
      JSON.stringify(sanitizeOAuthTraceValue(`rejected:access_token=${SECRET}`)),
    ).not.toContain(SECRET);
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

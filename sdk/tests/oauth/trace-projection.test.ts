import { projectOAuthTraceSnapshot } from "../../src/oauth/state-machines/trace.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

describe("OAuth trace projection", () => {
  it("keeps DCR fallback failures attached to the registration step", () => {
    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "authorization_request",
        clientId: "configured-client-id",
        authorizationUrl: "https://auth.example.com/authorize?client_id=test",
        httpHistory: [
          {
            step: "request_client_registration",
            timestamp: 1_000,
            request: {
              method: "POST",
              url: "https://auth.example.com/register",
              headers: {
                "Content-Type": "application/json",
              },
              body: {
                client_name: "MCPJam Inspector",
              },
            },
            response: {
              status: 400,
              statusText: "Bad Request",
              headers: {
                "content-type": "application/json",
              },
              body: {
                error_type: "dynamic_client_registration_not_enabled",
                error_message:
                  "Dynamic Client Registration is not enabled for this project.",
              },
            },
          },
        ],
        infoLogs: [],
      },
    });

    const registrationStep = snapshot.steps.find(
      (step) => step.step === "request_client_registration",
    );
    const authorizationStep = snapshot.steps.find(
      (step) => step.step === "authorization_request",
    );

    expect(registrationStep).toMatchObject({
      step: "request_client_registration",
      status: "success",
      recovered: true,
      recoveryMessage:
        "Using pre-registered client credentials after registration failed.",
      error:
        "dynamic_client_registration_not_enabled: Dynamic Client Registration is not enabled for this project.",
    });
    expect(authorizationStep).toMatchObject({
      step: "authorization_request",
      status: "success",
    });
  });

  it("omits redaction for PKCE and authorization code when sanitize is false", () => {
    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "complete",
        codeVerifier: "full-code-verifier-secret-value",
        authorizationCode: "auth-code-abc123",
        authorizationUrl:
          "https://auth.example.com/authorize?client_id=x&code_challenge=challengexxx",
        httpHistory: [],
        infoLogs: [],
      },
      sanitize: false,
    });

    const pkceStep = snapshot.steps.find(
      (step) => step.step === "generate_pkce_parameters",
    );
    const codeStep = snapshot.steps.find(
      (step) => step.step === "received_authorization_code",
    );

    expect(pkceStep?.details).toMatchObject({
      codeVerifier: "full-code-verifier-secret-value",
    });
    expect(codeStep?.details).toMatchObject({ code: "auth-code-abc123" });
  });

  // Regression: error strings interpolate upstream response fields (e.g.
  // `Token request failed: ${body.error} - ${body.error_description}`). Once
  // the request executor stopped redacting live response bodies, an AS that
  // echoes a credential back in error_description would reach rendered trace
  // output verbatim unless the projection redacts error strings too.
  it("redacts credentials echoed into error messages when sanitizing", () => {
    const leaked =
      "Token request failed: invalid_client - client_secret=cs_supersecretvalue1234567890 was rejected";

    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "token_request",
        error: leaked,
        httpHistory: [
          {
            step: "token_request",
            timestamp: 1_000,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: {},
              body: { grant_type: "authorization_code" },
            },
            error: {
              message:
                "upstream said Bearer ntn_supersecretaccesstokenvalue1234567890",
            },
          },
        ],
        infoLogs: [],
      },
      sanitize: true,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("cs_supersecretvalue1234567890");
    expect(serialized).not.toContain("ntn_supersecretaccesstokenvalue1234567890");
    expect(snapshot.error).toContain("client_secret=[redacted]");
    // The message must stay a readable string, not be reshaped into an object.
    expect(typeof snapshot.error).toBe("string");
    expect(snapshot.error).toContain("Token request failed: invalid_client");

    const tokenStep = snapshot.steps.find((step) => step.step === "token_request");
    expect(tokenStep?.error).toContain("Bearer [redacted]");
  });

  // Regression: when the current step already has an httpHistory entry, the
  // `state.error` fallback in the step projection is the only place the error
  // string reaches the snapshot — `inferHttpHistoryEntryError` only mines
  // responses for `request_client_registration`, and the "no entry for the
  // current step" branch is skipped because the entry exists. That fallback
  // used to emit `state.error` raw even when sanitizing.
  it("redacts the state-error fallback on a step that already has an http entry", () => {
    const leaked =
      "Token request failed: invalid_client - client_secret=cs_stateerrorfallback1234567890 was rejected";

    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "token_request",
        error: leaked,
        httpHistory: [
          {
            step: "token_request",
            timestamp: 1_000,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: {},
              body: { grant_type: "authorization_code" },
            },
            response: {
              status: 400,
              statusText: "Bad Request",
              headers: { "content-type": "application/json" },
              body: { error: "invalid_client" },
            },
            // Deliberately no `error` — the executor recorded the response but
            // no transport-level failure.
          },
        ],
        infoLogs: [],
      },
      sanitize: true,
    });

    const tokenStep = snapshot.steps.find(
      (step) => step.step === "token_request",
    );
    expect(tokenStep?.status).toBe("error");
    expect(tokenStep?.error).toContain("client_secret=[redacted]");
    expect(JSON.stringify(snapshot)).not.toContain(
      "cs_stateerrorfallback1234567890",
    );
  });

  it("leaves the state-error fallback intact when sanitize is false", () => {
    const raw =
      "Token request failed: client_secret=cs_localdevfallback1234567890";

    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "token_request",
        error: raw,
        httpHistory: [
          {
            step: "token_request",
            timestamp: 1_000,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: {},
              body: { grant_type: "authorization_code" },
            },
            response: {
              status: 400,
              statusText: "Bad Request",
              headers: {},
              body: { error: "invalid_client" },
            },
          },
        ],
        infoLogs: [],
      },
      sanitize: false,
    });

    const tokenStep = snapshot.steps.find(
      (step) => step.step === "token_request",
    );
    expect(tokenStep?.error).toBe(raw);
  });

  it("leaves error messages intact when sanitize is false", () => {
    const raw = "Token request failed: client_secret=cs_localdevsecret123456";
    const snapshot = projectOAuthTraceSnapshot({
      state: {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "token_request",
        error: raw,
        httpHistory: [],
        infoLogs: [],
      },
      sanitize: false,
    });

    expect(snapshot.error).toBe(raw);
  });
});

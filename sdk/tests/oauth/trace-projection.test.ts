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
});

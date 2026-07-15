import { describe, expect, it } from "vitest";
import { buildXAAActions } from "../sequence-actions";
import { createInitialXAAFlowState } from "../types";
import type { XAAFlowState, XAAFlowStep } from "../types";

// The request/process split stores a step's resolved values (idJag, accessToken,
// tokenEndpoint, ...) while the machine is still resting at the PRIOR "request"
// step. buildXAAActions must therefore reveal an arrow's detail chip only once
// its step has actually been reached — never one click early just because the
// underlying value already exists in state.

const detailsFor = (flowStep: XAAFlowStep, id: string) =>
  buildXAAActions(
    createInitialXAAFlowState({
      currentStep: flowStep,
      serverUrl: "https://mcp.example.com",
      resourceUrl: "https://mcp.example.com",
      resourceMetadataUrl: "https://mcp.example.com/.well-known/x",
      authzServerIssuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/token",
      identityAssertion: "id-token",
      idJag: "id-jag",
      accessToken: "access-token",
      tokenType: "Bearer",
      email: "user@example.com",
    }),
  ).find((action) => action.id === id)?.details;

describe("buildXAAActions detail gating", () => {
  it("hides every chip at idle even when values are already populated", () => {
    const actions = buildXAAActions(
      createInitialXAAFlowState({
        currentStep: "idle",
        accessToken: "access-token",
        idJag: "id-jag",
        tokenEndpoint: "https://auth.example.com/token",
      }),
    );
    expect(actions.every((action) => action.details === undefined)).toBe(true);
  });

  it("does not reveal a 'received' chip while resting at its request step", () => {
    // Resting at jwt_bearer_request (request fired, not yet processed): the
    // access token is in state, but the received_access_token arrow and the
    // downstream complete arrow must stay chip-less until reached.
    expect(detailsFor("jwt_bearer_request", "received_access_token")).toBeUndefined();
    expect(detailsFor("jwt_bearer_request", "complete")).toBeUndefined();
    // The arrow the user just fired does show its own chip.
    expect(detailsFor("jwt_bearer_request", "jwt_bearer_request")).toBeDefined();
  });

  it("keeps the ID-JAG chip hidden until the token-exchange is processed", () => {
    expect(detailsFor("token_exchange_request", "received_id_jag")).toBeUndefined();
    expect(detailsFor("received_id_jag", "received_id_jag")).toBeDefined();
  });

  it("reveals a chip once its own step is reached", () => {
    expect(detailsFor("received_access_token", "received_access_token")).toBeDefined();
    expect(detailsFor("received_authz_metadata", "received_authz_metadata")).toBeDefined();
  });
});

describe("buildXAAActions terminal probes", () => {
  it("ends a rejected probe at its JWT request arrow", () => {
    const actions = buildXAAActions(
      createInitialXAAFlowState({
        currentStep: "jwt_bearer_request",
        negativeTestMode: "unknown_kid",
        negativeProbe: { outcome: "rejected", status: 400 },
      }),
    );

    expect(actions.at(-1)?.id).toBe("jwt_bearer_request");
    expect(
      actions.some((action) => action.id === "received_access_token"),
    ).toBe(false);
  });

  it("ends an incorrectly accepted probe at its response arrow", () => {
    const actions = buildXAAActions(
      createInitialXAAFlowState({
        currentStep: "received_access_token",
        negativeTestMode: "unknown_kid",
        negativeProbe: { outcome: "accepted", status: 200 },
        accessToken: "token",
      }),
    );

    expect(actions.at(-1)?.id).toBe("received_access_token");
    expect(
      actions.some((action) => action.id === "authenticated_mcp_request"),
    ).toBe(false);
  });
});

// The sequence diagram is data-driven: these actions ARE the diagram. The
// three identity-leg actions branch on the identity assertion format (input
// axis, D6); everything else — and every OIDC label — must stay unchanged.

function makeFlowState(overrides: Partial<XAAFlowState> = {}): XAAFlowState {
  return {
    ...createInitialXAAFlowState({
      serverUrl: "https://example.test/mcp",
      email: "demo.user@example.com",
    }),
    ...overrides,
  };
}

function actionById(actions: ReturnType<typeof buildXAAActions>, id: string) {
  const action = actions.find((a) => a.id === id);
  expect(action, `action ${id} must exist`).toBeDefined();
  return action!;
}

describe("buildXAAActions identity assertion format", () => {
  it("uses the same one-arrow-per-step action ids for OIDC and SAML", () => {
    const expected = [
      "discover_resource_metadata",
      "received_resource_metadata",
      "discover_authz_metadata",
      "received_authz_metadata",
      "user_authentication",
      "received_identity_assertion",
      "token_exchange_request",
      "received_id_jag",
      "inspect_id_jag",
      "jwt_bearer_request",
      "received_access_token",
      "authenticated_mcp_request",
      "complete",
    ];

    expect(buildXAAActions(makeFlowState()).map((action) => action.id)).toEqual(
      expected,
    );
    expect(
      buildXAAActions(
        makeFlowState({ identityAssertionFormat: "saml" }),
      ).map((action) => action.id),
    ).toEqual(expected);
  });

  it("keeps the OIDC labels unchanged on the default format", () => {
    const actions = buildXAAActions(
      makeFlowState({ identityAssertion: "header.payload.sig" }),
    );

    expect(actionById(actions, "user_authentication").label).toBe(
      "Simulate sign-in at MCPJam IdP",
    );
    const received = actionById(actions, "received_identity_assertion");
    expect(received.label).toBe("ID token issued by MCPJam IdP");
    expect(received.details).toEqual([
      { label: "Type", value: "OIDC ID token" },
    ]);
    const exchange = actionById(actions, "token_exchange_request");
    expect(exchange.description).toContain("ID token");
    // No subject_token_type detail on OIDC runs — the original detail set.
    expect(exchange.details).toHaveLength(1);
    expect(exchange.details?.[0].label).toBe("Mode");
  });

  it("swaps the three identity-leg labels for a SAML run", () => {
    const actions = buildXAAActions(
      makeFlowState({
        identityAssertionFormat: "saml",
        subjectIdentifierFormat: "saml-nameid",
        identityAssertion: "base64-saml-assertion",
        identityAssertionSubject: {
          issuer: "https://idp.example.test",
          nameid: "user-12345",
          nameidFormat:
            "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
          spNameQualifier: "https://ras.example.test",
        },
      }),
    );

    const auth = actionById(actions, "user_authentication");
    expect(auth.label).toBe("Mock SAML SSO");
    expect(auth.description).toContain("SP-initiated SAML SSO (mocked)");

    const received = actionById(actions, "received_identity_assertion");
    expect(received.label).toBe("SAML assertion issued");
    expect(received.details).toEqual([
      { label: "Type", value: "SAML 2.0 assertion (base64)" },
      { label: "NameID", value: "user-12345" },
    ]);

    const exchange = actionById(actions, "token_exchange_request");
    expect(exchange.label).toBe("Token exchange");
    expect(exchange.description).toContain("SAML assertion");
    expect(exchange.details).toContainEqual({
      label: "subject_token_type",
      value: "urn:ietf:params:oauth:token-type:saml2",
    });
  });

  it("renders no NameID detail when the SAML subject metadata is absent", () => {
    // Absence is semantic: never render a placeholder NameID.
    const actions = buildXAAActions(
      makeFlowState({
        identityAssertionFormat: "saml",
        identityAssertion: "base64-saml-assertion",
      }),
    );

    const received = actionById(actions, "received_identity_assertion");
    expect(received.details).toEqual([
      { label: "Type", value: "SAML 2.0 assertion (base64)" },
    ]);
  });

  it("renders no assertion-type details before the assertion is issued", () => {
    const actions = buildXAAActions(
      makeFlowState({ identityAssertionFormat: "saml" }),
    );
    expect(
      actionById(actions, "received_identity_assertion").details,
    ).toBeUndefined();
  });
});

describe("buildXAAActions registration strategies", () => {
  const actionIds = (overrides: Partial<XAAFlowState>) =>
    buildXAAActions(makeFlowState(overrides)).map((action) => action.id);

  it("omits registration arrows for a preregistered client", () => {
    const ids = actionIds({ registrationStrategy: "preregistered" });
    expect(ids).not.toContain("request_client_registration");
    expect(ids).not.toContain("received_client_credentials");
    expect(ids).not.toContain("fetch_client_metadata_document");
    expect(ids).not.toContain("received_client_metadata");
  });

  it("renders separate request and response arrows for open DCR", () => {
    const ids = actionIds({
      registrationStrategy: "dcr",
      dcrRegistrationReused: false,
    });
    const request = ids.indexOf("request_client_registration");
    expect(request).toBeGreaterThan(-1);
    expect(ids[request + 1]).toBe("received_client_credentials");
  });

  it("keeps reused DCR credentials as a standalone local action", () => {
    const ids = actionIds({
      registrationStrategy: "dcr",
      dcrRegistrationReused: true,
    });
    expect(ids).not.toContain("request_client_registration");
    expect(ids).toContain("received_client_credentials");
  });

  it("renders separate preflight and ready arrows for CIMD", () => {
    const ids = actionIds({ registrationStrategy: "cimd" });
    const request = ids.indexOf("fetch_client_metadata_document");
    expect(request).toBeGreaterThan(-1);
    expect(ids[request + 1]).toBe("received_client_metadata");
  });
});

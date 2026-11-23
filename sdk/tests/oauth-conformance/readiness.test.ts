import { oauthReadiness } from "../../src/oauth-conformance/readiness.js";

const config = {} as Parameters<typeof oauthReadiness>[0];
const state = (metadata?: Record<string, unknown>) =>
  ({
    authorizationServerUrl: "https://auth.example.com",
    authorizationServerMetadata: metadata,
  }) as unknown as Parameters<typeof oauthReadiness>[1];

describe("oauthReadiness", () => {
  it("lists iss as met when the authorization server advertises it", () => {
    expect(
      oauthReadiness(
        config,
        state({
          issuer: "https://auth.example.com",
          authorization_response_iss_parameter_supported: true,
        })
      )
    ).toEqual({
      passedAdvice: [
        {
          id: "readiness-oauth-iss-advertised",
          title: "Authorization Response iss",
          specStrength: "SHOULD",
        },
      ],
    });
  });

  it("warns, and claims no pass, when it does not", () => {
    const advice = oauthReadiness(
      config,
      state({ issuer: "https://auth.example.com" })
    );
    expect(advice.passedAdvice).toBeUndefined();
    expect(advice.readiness?.map((warning) => warning.id)).toEqual([
      "readiness-oauth-iss-advertised",
    ]);
  });

  it("says nothing without metadata or when the advice was left out", () => {
    expect(oauthReadiness(config, state())).toEqual({});
    expect(
      oauthReadiness(
        { readinessIds: [] } as unknown as Parameters<typeof oauthReadiness>[0],
        state({ authorization_response_iss_parameter_supported: true })
      )
    ).toEqual({});
  });
});

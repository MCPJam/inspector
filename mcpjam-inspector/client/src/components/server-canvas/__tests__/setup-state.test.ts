import { describe, expect, it } from "vitest";
import { CANVAS_SETUP_OFFERED, configuredSetup } from "../setup-state";

describe("configuredSetup", () => {
  it("reads nothing as set up for a plain server", () => {
    expect(configuredSetup({})).toEqual([]);
  });

  it("reads a pre-registered OAuth client from either stored field", () => {
    expect(configuredSetup({ registrationMode: "preregistered" })).toEqual([
      "pre-registered-client",
    ]);
    expect(
      configuredSetup({
        oauthFlowProfile: { registrationStrategy: "preregistered" } as never,
      }),
    ).toEqual(["pre-registered-client"]);
    expect(configuredSetup({ registrationMode: "dcr" })).toEqual([]);
  });

  it("reads XAA from the auth method or the xaaConfigured mirror", () => {
    expect(configuredSetup({ authMethod: "xaa" })).toEqual([
      "enterprise-managed-authorization",
    ]);
    expect(configuredSetup({ authMethod: "auto", useXaa: true })).toEqual([
      "enterprise-managed-authorization",
    ]);
  });

  it("offers only setup the Configuration tab has", () => {
    expect([...CANVAS_SETUP_OFFERED].sort()).toEqual([
      "enterprise-managed-authorization",
      "pre-registered-client",
    ]);
  });
});

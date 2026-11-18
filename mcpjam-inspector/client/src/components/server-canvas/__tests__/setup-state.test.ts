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

  it("lets the saved registration mode override a stale profile strategy", () => {
    expect(
      configuredSetup({
        registrationMode: "auto",
        oauthFlowProfile: { registrationStrategy: "preregistered" } as never,
      }),
    ).toEqual([]);
  });

  it("does not read an XAA server's pre-registered client as OAuth setup", () => {
    expect(
      configuredSetup({ registrationMode: "preregistered", authMethod: "xaa" }),
    ).toEqual([]);
    expect(
      configuredSetup({ registrationMode: "preregistered", useXaa: true }),
    ).toEqual([]);
  });

  it("offers only the setup whose result the page can record", () => {
    expect(CANVAS_SETUP_OFFERED).toEqual(["pre-registered-client"]);
  });
});

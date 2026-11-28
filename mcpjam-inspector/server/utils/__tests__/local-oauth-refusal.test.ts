import { describe, expect, it } from "vitest";
import { oauthRefusalFromAuthorize } from "../local-oauth-refusal.js";

const SERVER = { serverId: "srv-1", serverName: "CTRL UAT" };

describe("oauthRefusalFromAuthorize", () => {
  it("raises a shared account's refusal with the backend's words and cause", () => {
    const refusal = oauthRefusalFromAuthorize(
      {
        oauthAccessToken: null,
        oauthUnavailableReason: "credential_export_denied",
        oauthUnavailablePolicy: "hostedOnlyAccount",
        oauthUnavailableCause: "not_acknowledged",
        oauthUnavailableMessage: "Ask a project admin to allow local runs.",
      },
      SERVER,
    );
    expect(refusal).toMatchObject({
      status: 403,
      message: "Ask a project admin to allow local runs.",
      details: {
        exportDenied: true,
        policy: "hostedOnlyAccount",
        cause: "not_acknowledged",
        credentialRefusal: "export_denied",
        serverId: "srv-1",
      },
    });
  });

  it.each([
    [
      "not_acknowledged",
      /local runs are off for it\. Ask a project admin to turn on Allow local runs on the server's Auth tab\.$/,
    ],
    ["client_upgrade_required", /Update MCPJam/],
    [undefined, /Run it from MCPJam instead/],
  ])(
    "words a %s refusal itself when the backend sent no sentence",
    (cause, expected) => {
      const refusal = oauthRefusalFromAuthorize(
        {
          oauthUnavailableReason: "credential_export_denied",
          oauthUnavailablePolicy: "hostedOnlyAccount",
          oauthUnavailableCause: cause,
        },
        SERVER,
      );
      expect(refusal?.message).toMatch(expected);
    },
  );

  it("names the organization's policy when that is what refused", () => {
    const refusal = oauthRefusalFromAuthorize(
      {
        oauthUnavailableReason: "credential_export_denied",
        oauthUnavailablePolicy: "credentialExportPolicy",
      },
      SERVER,
    );
    expect(refusal?.message).toMatch(/organization admin/);
    // An admin reading it can find the switch.
    expect(refusal?.message).toContain(
      "turn on Allow credential export in Organization settings under Security",
    );
    expect(refusal?.details).toMatchObject({
      policy: "credentialExportPolicy",
    });
    expect(refusal?.details).not.toHaveProperty("cause");
  });

  it("asks for a reconnect when the server moved, naming where it points now", () => {
    expect(
      oauthRefusalFromAuthorize(
        { oauthUnavailableReason: "credential_origin_mismatch" },
        { ...SERVER, serverUrl: "https://new.example.com/mcp" },
      ),
    ).toMatchObject({
      status: 403,
      details: {
        secretOriginMismatch: true,
        targetOrigin: "https://new.example.com",
      },
    });
  });

  it("leaves a missing or expired token to the refresh", () => {
    expect(oauthRefusalFromAuthorize({ oauthAccessToken: null }, SERVER)).toBe(
      null,
    );
    expect(
      oauthRefusalFromAuthorize(
        { oauthUnavailableReason: "refresh_in_progress" },
        SERVER,
      ),
    ).toBe(null);
    expect(
      oauthRefusalFromAuthorize(
        {
          oauthAccessToken: "token",
          oauthUnavailableReason: "credential_export_denied",
        },
        SERVER,
      ),
    ).toBe(null);
  });
});

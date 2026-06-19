import { afterEach, describe, expect, it } from "vitest";
import { deriveOAuthProfileFromServer } from "../utils";
import type { ServerWithName } from "@/hooks/use-app-state";

function httpServer(
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name: "xaa",
    enabled: true,
    useOAuth: true,
    retryCount: 0,
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    config: { url: new URL("http://localhost:8787/mcp") },
    ...overrides,
  } as ServerWithName;
}

describe("deriveOAuthProfileFromServer stored-credential fallback", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("fills clientId and scopes from browser-stored OAuth state when oauthFlowProfile is empty", () => {
    // What the Connect editor reads: a registered client id and the granted
    // scopes that never made it into oauthFlowProfile.
    localStorage.setItem(
      "mcp-client-xaa",
      JSON.stringify({ client_id: "client_bc147d46f04cb865" }),
    );
    localStorage.setItem(
      "mcp-oauth-config-xaa",
      JSON.stringify({ scopes: ["mcp.access"] }),
    );

    const profile = deriveOAuthProfileFromServer(httpServer());
    expect(profile.clientId).toBe("client_bc147d46f04cb865");
    expect(profile.scopes).toBe("mcp.access");
  });

  it("prefers the explicit oauthFlowProfile over stored state", () => {
    localStorage.setItem(
      "mcp-client-xaa",
      JSON.stringify({ client_id: "stored-client" }),
    );

    const profile = deriveOAuthProfileFromServer(
      httpServer({
        oauthFlowProfile: {
          serverUrl: "http://localhost:8787/mcp",
          clientId: "profile-client",
          clientSecret: "",
          scopes: "read",
          customHeaders: [],
        } as ServerWithName["oauthFlowProfile"],
      }),
    );
    expect(profile.clientId).toBe("profile-client");
    expect(profile.scopes).toBe("read");
  });

  it("returns empty fields when nothing is stored", () => {
    const profile = deriveOAuthProfileFromServer(httpServer());
    expect(profile.clientId).toBe("");
    expect(profile.scopes).toBe("");
  });
});

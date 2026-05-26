import { describe, expect, it } from "vitest";
import {
  serializeServersForPersistence,
  serializeServersForSharing,
} from "../project-serialization";
import type { ServerWithName } from "@/state/app-types";

function makeOAuthHttpServer(
  scopes: unknown,
  envOverrides: Partial<ServerWithName> = {}
): Record<string, ServerWithName> {
  return {
    s1: {
      name: "s1",
      enabled: true,
      useOAuth: true,
      retryCount: 0,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      config: { url: new URL("https://example.test/mcp") },
      oauthFlowProfile: {
        serverUrl: "https://example.test/mcp",
        resourceUrl: "https://example.test/.well-known/oauth-resource",
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
        clientId: "client-1",
        clientSecret: "",
        // Cast through unknown so we can probe legacy/UI shapes.
        scopes: scopes as string,
        customHeaders: [],
      },
      ...envOverrides,
    } as ServerWithName,
  };
}

describe("project-serialization OAuth scopes coercion", () => {
  // The Convex `servers.oauthScopes` field is v.array(v.string()), but
  // OAuthTestProfile.scopes is a UI-shaped string. The serializer is the
  // boundary that must convert; without this, syncProjectServers patches the
  // array field with a raw string and trips the schema validator. See the
  // mergeServersIntoExistingProject failure on the localStorage→Convex
  // migration path.
  it("emits empty-string scopes as []", () => {
    const out = serializeServersForPersistence(makeOAuthHttpServer(""));
    const profile = (out.s1 as any).oauthFlowProfile;
    expect(Array.isArray(profile.scopes)).toBe(true);
    expect(profile.scopes).toEqual([]);
  });

  it("splits comma-separated scopes string into array", () => {
    const out = serializeServersForPersistence(
      makeOAuthHttpServer("openid,profile,email")
    );
    expect((out.s1 as any).oauthFlowProfile.scopes).toEqual([
      "openid",
      "profile",
      "email",
    ]);
  });

  it("splits whitespace-separated scopes string into array", () => {
    const out = serializeServersForPersistence(
      makeOAuthHttpServer("read write admin")
    );
    expect((out.s1 as any).oauthFlowProfile.scopes).toEqual([
      "read",
      "write",
      "admin",
    ]);
  });

  it("passes through array scopes unchanged", () => {
    const out = serializeServersForPersistence(
      makeOAuthHttpServer(["read", "write"])
    );
    expect((out.s1 as any).oauthFlowProfile.scopes).toEqual(["read", "write"]);
  });

  it("applies the same coercion on the sharing path", () => {
    const out = serializeServersForSharing(makeOAuthHttpServer("a, b ,, c"));
    expect((out.s1 as any).oauthFlowProfile.scopes).toEqual(["a", "b", "c"]);
  });
});

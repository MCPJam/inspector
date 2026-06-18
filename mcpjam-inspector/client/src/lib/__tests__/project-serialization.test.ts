import { describe, expect, it } from "vitest";
import {
  serversHaveChanged,
  serializeServersForPersistence,
  serializeServersForSharing,
  deserializeServersFromConvex,
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

describe("serversHaveChanged redacted secrets", () => {
  it("does not treat revealed local headers as changed when remote headers are redacted", () => {
    const local: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useOAuth: false,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        hasHeaders: true,
        config: {
          url: "https://example.test/mcp",
          requestInit: {
            headers: { Authorization: "Bearer revealed" },
          },
        } as any,
      },
    };

    expect(
      serversHaveChanged(local, [
        {
          name: "s1",
          enabled: true,
          useOAuth: false,
          hasHeaders: true,
          url: "https://example.test/mcp",
        },
      ])
    ).toBe(false);
  });

  it("does not treat revealed local env as changed when remote env is redacted", () => {
    const local: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useOAuth: false,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        hasEnv: true,
        config: {
          command: "node",
          env: { FOO: "revealed" },
        } as any,
      },
    };

    expect(
      serversHaveChanged(local, [
        {
          name: "s1",
          enabled: true,
          useOAuth: false,
          hasEnv: true,
          command: "node",
        },
      ])
    ).toBe(false);
  });
});

describe("project-serialization xaaAuthzIssuer round-trip", () => {
  // The XAA "Configure Server to Test" modal reads the Authorization Server
  // Issuer from server.xaaAuthzIssuer. If serialize/deserialize drops it, the
  // field resets every time the runtime entry is rebuilt from the catalog
  // (e.g. on a reconnect that needs re-auth).
  it("persists xaaAuthzIssuer through serialization", () => {
    const out = serializeServersForPersistence(
      makeOAuthHttpServer("read", {
        xaaAuthzIssuer: "https://issuer.test",
      })
    );
    expect((out.s1 as any).xaaAuthzIssuer).toBe("https://issuer.test");
  });

  it("restores xaaAuthzIssuer from the flat servers table", () => {
    const out = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        clientId: "client-1",
        xaaAuthzIssuer: "https://issuer.test",
      },
    ]);
    expect(out.s1.xaaAuthzIssuer).toBe("https://issuer.test");
  });

  it("treats an xaaAuthzIssuer change as a difference to resync", () => {
    // No oauthFlowProfile on either side, so the only thing that can differ
    // is the issuer — otherwise the assertions could pass on an unrelated
    // OAuth-profile mismatch and never exercise the issuer comparison.
    const local: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useOAuth: true,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        config: { url: new URL("https://example.test/mcp") },
        xaaAuthzIssuer: "https://issuer.test",
      } as ServerWithName,
    };

    // Same issuer (otherwise identical) → no resync.
    expect(
      serversHaveChanged(local, [
        {
          name: "s1",
          enabled: true,
          useOAuth: true,
          url: "https://example.test/mcp",
          xaaAuthzIssuer: "https://issuer.test",
        },
      ])
    ).toBe(false);

    // Only the issuer differs → resync.
    expect(
      serversHaveChanged(local, [
        {
          name: "s1",
          enabled: true,
          useOAuth: true,
          url: "https://example.test/mcp",
          xaaAuthzIssuer: "https://different.test",
        },
      ])
    ).toBe(true);
  });
});

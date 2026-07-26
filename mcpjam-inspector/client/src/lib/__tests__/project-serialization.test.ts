import { describe, expect, it } from "vitest";
import {
  deserializeServersFromConvex,
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

describe("registrationMode round-trip", () => {
  it("round-trips a known strategy through deserialize", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        registrationMode: "dcr",
      },
    ]);
    expect(servers.s1.registrationMode).toBe("dcr");
  });

  it("normalizes the legacy pre_registered spelling to preregistered", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        registrationMode: "pre_registered",
      },
    ]);
    expect(servers.s1.registrationMode).toBe("preregistered");
  });

  it("imports the legacy per-flow keys into the unified field (canonical wins)", () => {
    // Old exports carried xaaRegistrationStrategy (debugger) and/or
    // oauthRegistrationMode; both must land on registrationMode.
    const servers = deserializeServersFromConvex([
      {
        name: "legacy-xaa",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        xaaRegistrationStrategy: "pre_registered",
      },
      {
        name: "legacy-oauth",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        oauthRegistrationMode: "auto",
      },
      {
        name: "both-keys",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        registrationMode: "cimd",
        xaaRegistrationStrategy: "dcr",
      },
    ]);
    expect(servers["legacy-xaa"].registrationMode).toBe("preregistered");
    expect(servers["legacy-oauth"].registrationMode).toBe("auto");
    expect(servers["both-keys"].registrationMode).toBe("cimd");
  });

  it("drops an unknown persisted strategy so the flow falls back to the default", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        registrationMode: "totally-bogus",
      },
    ]);
    expect(servers.s1.registrationMode).toBeUndefined();
  });

  it("serializes a known strategy for persistence", () => {
    const server: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useXaa: true,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        config: { url: new URL("https://example.test/mcp") },
        registrationMode: "cimd",
      } as unknown as ServerWithName,
    };
    const out = serializeServersForPersistence(server);
    expect((out.s1 as any).registrationMode).toBe("cimd");
  });
});

describe("xaaIdentityAssertionFormat round-trip", () => {
  it("round-trips a known format through deserialize", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        xaaIdentityAssertionFormat: "saml",
      },
    ]);
    expect(servers.s1.xaaIdentityAssertionFormat).toBe("saml");
  });

  it("leaves the field absent when the wire omits it (legacy rows = oidc default)", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
      },
    ]);
    expect(servers.s1.xaaIdentityAssertionFormat).toBeUndefined();
  });

  it("drops an unknown persisted format so the debugger falls back to oidc", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        xaaIdentityAssertionFormat: "totally-bogus",
      },
    ]);
    expect(servers.s1.xaaIdentityAssertionFormat).toBeUndefined();
  });

  it("serializes a known format for persistence", () => {
    const server: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useXaa: true,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        config: { url: new URL("https://example.test/mcp") },
        xaaIdentityAssertionFormat: "saml",
      } as unknown as ServerWithName,
    };
    const out = serializeServersForPersistence(server);
    expect((out.s1 as any).xaaIdentityAssertionFormat).toBe("saml");
  });
});

describe("serversHaveChanged redacted secrets", () => {
  it("marks visible bearer authorization headers as bearer-token metadata", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "s1",
        enabled: true,
        useOAuth: false,
        hasHeaders: true,
        url: "https://example.test/mcp",
        headers: { authorization: "bearer revealed" },
      },
    ]);

    expect(servers.s1.hasHeaders).toBe(true);
    expect(servers.s1.hasBearerToken).toBe(true);
  });

  it("infers remote bearer metadata from lowercase authorization headers", () => {
    const local: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useOAuth: false,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        hasHeaders: true,
        hasBearerToken: true,
        config: {
          url: "https://example.test/mcp",
          requestInit: {
            headers: { authorization: "bearer revealed" },
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
          headers: { authorization: "bearer revealed" },
        },
      ])
    ).toBe(false);
  });

  it("treats bearer-token metadata changes as server changes", () => {
    const local: Record<string, ServerWithName> = {
      s1: {
        name: "s1",
        enabled: true,
        useOAuth: false,
        retryCount: 0,
        lastConnectionTime: new Date(),
        connectionStatus: "disconnected",
        hasHeaders: true,
        hasBearerToken: true,
        config: {
          url: "https://example.test/mcp",
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
    ).toBe(true);
  });

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

describe("XAA DCR runtime serialization boundary", () => {
  it("hydrates sanitized status but never writes runtime registration state", () => {
    const hydrated = deserializeServersFromConvex([
      {
        name: "dcr-server",
        enabled: true,
        useXaa: true,
        url: "https://example.test/mcp",
        registrationMode: "dcr",
        xaaDcrStatus: "registered",
        xaaDcrClientId: "runtime-client",
        xaaDcrIssuer: "https://as.example",
        xaaDcrRegisteredAt: 123,
        xaaDcrClientSecretExpiresAt: 456,
        xaaDcrTokenEndpointAuthMethod: "client_secret_post",
        hasXaaDcrRegistration: true,
      },
    ]);
    expect(hydrated["dcr-server"]).toMatchObject({
      xaaDcrStatus: "registered",
      xaaDcrClientId: "runtime-client",
      hasXaaDcrRegistration: true,
    });

    for (const serialized of [
      serializeServersForPersistence(hydrated),
      serializeServersForSharing(hydrated),
    ]) {
      const output = serialized["dcr-server"] as Record<string, unknown>;
      expect(output.registrationMode).toBe("dcr");
      expect(Object.keys(output).some((key) => key.startsWith("xaaDcr"))).toBe(
        false,
      );
      expect(output).not.toHaveProperty("hasXaaDcrRegistration");
      expect(JSON.stringify(output)).not.toContain("runtime-client");
    }
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

describe("OAuth test-profile round-trip (protocol version + registration strategy)", () => {
  it("restores persisted strategy and protocol version from flat Convex columns", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "prereg",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        clientId: "client_abc",
        oauthScopes: ["openid", "email"],
        oauthProtocolVersion: "2025-06-18",
        oauthRegistrationStrategy: "preregistered",
      },
    ]);

    const profile = servers.prereg.oauthFlowProfile!;
    expect(profile.registrationStrategy).toBe("preregistered");
    expect(profile.protocolVersion).toBe("2025-06-18");
    expect(profile.clientId).toBe("client_abc");
  });

  it("survives a 2026-07-28 draft-era protocol version through the round-trip", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "draft-2026",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        clientId: "client_abc",
        oauthProtocolVersion: "2026-07-28",
        oauthRegistrationStrategy: "dcr",
      },
    ]);

    const profile = servers["draft-2026"].oauthFlowProfile!;
    expect(profile.protocolVersion).toBe("2026-07-28");
    expect(profile.registrationStrategy).toBe("dcr");
  });

  it("builds a profile even when only the strategy columns are present", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "cimd-only",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        oauthRegistrationStrategy: "cimd",
      },
    ]);

    expect(servers["cimd-only"].oauthFlowProfile?.registrationStrategy).toBe(
      "cimd",
    );
  });

  it("ignores unknown wire values so the reader-side defaults apply", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "future",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        clientId: "client_abc",
        oauthProtocolVersion: "2099-01-01",
        oauthRegistrationStrategy: "quantum",
      },
    ]);

    const profile = servers.future.oauthFlowProfile as any;
    expect(profile.registrationStrategy).toBeUndefined();
    expect(profile.protocolVersion).toBeUndefined();
    expect(profile.clientId).toBe("client_abc");
  });

  it("legacy rows without the columns keep no strategy on the profile", () => {
    const servers = deserializeServersFromConvex([
      {
        name: "legacy",
        enabled: true,
        useOAuth: true,
        url: "https://example.test/mcp",
        clientId: "client_abc",
      },
    ]);

    const profile = servers.legacy.oauthFlowProfile as any;
    expect(profile.registrationStrategy).toBeUndefined();
    expect(profile.protocolVersion).toBeUndefined();
  });
});

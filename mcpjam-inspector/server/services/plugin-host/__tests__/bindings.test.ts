import { describe, expect, it } from "vitest";
import {
  pluginBindingDigest,
  pluginHostBindingDigest,
  pluginServerBindingDigest,
  pluginInstanceVersionId,
} from "../bindings.js";

describe("private server binding identity", () => {
  it("uses an installed version only when resolved and labels ordinary server identities explicitly", () => {
    expect(
      pluginInstanceVersionId(
        {
          kind: "plugin",
          serverId: "server",
          pluginId: "installed",
          pluginVersionId: "version-2",
          bundleHash: "hash",
          componentKey: "api",
        },
        "server",
        "target",
      ),
    ).toBe("version-2");
    expect(pluginInstanceVersionId(undefined, "server", "target")).toBe(
      "standalone:server:target",
    );
    expect(
      pluginInstanceVersionId(
        { kind: "standalone", serverId: "server" },
        "server",
        "target",
      ),
    ).toBe("standalone:server:target");
  });
  const config = {
    serverId: "server",
    credentialId: "saved-connection",
    credentialAuthorizedAt: 100,
    config: {
      transportType: "http",
      url: "https://fixture.invalid/mcp",
      credentialConfigurationId: "a".repeat(64),
      useOAuth: true,
    },
  };
  it("binds saved connection and configuration, not wire credentials", () => {
    expect(pluginServerBindingDigest(config)).toBe(
      pluginServerBindingDigest({
        ...config,
        config: {
          ...config.config,
          headers: { Authorization: "ephemeral" },
          timeout: 30,
        },
      }),
    );
    expect(pluginServerBindingDigest(config)).not.toBe(
      pluginServerBindingDigest({
        ...config,
        credentialAuthorizedAt: 101,
      }),
    );
    expect(pluginServerBindingDigest(config)).not.toBe(
      pluginServerBindingDigest({
        ...config,
        credentialId: "different-saved-connection",
      }),
    );
    expect(pluginServerBindingDigest(config)).not.toBe(
      pluginServerBindingDigest({
        ...config,
        config: { ...config.config, credentialConfigurationId: "b".repeat(64) },
      }),
    );
    expect(pluginServerBindingDigest(config)).not.toBe(
      pluginServerBindingDigest({
        ...config,
        config: { ...config.config, url: "https://other.invalid/mcp" },
      }),
    );
  });
  it("rejects incomplete credential identities and raw wire configs", () => {
    expect(() =>
      pluginServerBindingDigest({ ...config, credentialId: null }),
    ).toThrow();
    expect(() =>
      pluginServerBindingDigest({
        url: config.config.url,
        accessToken: "secret",
      }),
    ).toThrow();
  });
  it.each([undefined, null, [], "unavailable"])(
    "fails closed for unavailable configuration: %s",
    (value) => {
      expect(() => pluginServerBindingDigest(value)).toThrow(
        "INSTANCE_BINDING_UNAVAILABLE",
      );
    },
  );
  describe("host lifetime binding", () => {
    const host = {
      hostId: "host",
      hostConfigId: "config-1",
      modelId: "model",
      systemPrompt: "",
      temperature: 0,
      requireToolApproval: false,
      hostStyle: "chatgpt",
      executionScope: { kind: "project", projectId: "project" },
    };
    const withProfile = (
      apps: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({
      ...host,
      hostConfigId: "config-2",
      mcpProfile: { profileVersion: 1, apps, ...extra },
    });
    it("keeps the previous spelling for a config without mutable permissions", () => {
      const { hostConfigId: _id, requireToolApproval: _a, ...bare } = host;
      expect(pluginHostBindingDigest(bare)).toBe(pluginBindingDigest(bare));
    });
    it("ignores the client's extension and App permission toggles", () => {
      const before = pluginHostBindingDigest(host);
      // The first saved toggle creates the profile and a new config id.
      expect(
        pluginHostBindingDigest(
          withProfile({
            pluginExtensions: {
              enabled: true,
              capabilities: { mentions: false },
            },
          }),
        ),
      ).toBe(before);
      expect(
        pluginHostBindingDigest(
          withProfile({ pluginExtensions: { enabled: false } }),
        ),
      ).toBe(before);
      expect(
        pluginHostBindingDigest({
          ...withProfile({
            mcpAppsOverrides: { updateModelContext: true, message: false },
          }),
          requireToolApproval: true,
        }),
      ).toBe(before);
      // Other App-surface settings stay bound.
      const sandboxed = withProfile({
        pluginExtensions: { enabled: true },
        mcpAppsOverrides: { serverTools: false, openLinks: false },
      });
      expect(pluginHostBindingDigest(sandboxed)).not.toBe(before);
      expect(pluginHostBindingDigest(sandboxed)).toBe(
        pluginHostBindingDigest(
          withProfile({ mcpAppsOverrides: { openLinks: false } }),
        ),
      );
    });
    it.each([
      ["harness", { harness: "codex" }],
      ["host style", { hostStyle: "claude" }],
      ["Computer", { computer: { kind: "personal" } }],
      ["execution scope", { executionScope: { kind: "project", projectId: "other" } }],
      ["model", { modelId: "other-model" }],
      ["protocol profile", { mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" } }],
    ])("binds identity: a %s change still changes the binding", (_, change) => {
      expect(pluginHostBindingDigest({ ...host, ...change })).not.toBe(
        pluginHostBindingDigest(host),
      );
    });
  });

  it("accepts an authorized no-auth target with OAuth discovery enabled", () => {
    expect(() =>
      pluginServerBindingDigest({
        serverId: "server",
        credentialId: null,
        credentialAuthorizedAt: null,
        config: {
          transportType: "http",
          useOAuth: true,
          credentialConfigurationId: "a".repeat(64),
        },
      }),
    ).not.toThrow();
  });

});

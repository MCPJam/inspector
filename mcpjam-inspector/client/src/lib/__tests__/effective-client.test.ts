import { describe, expect, it } from "vitest";
import {
  resolveEffectiveClientCapabilities,
  resolveEffectiveHost,
  resolveServerInit,
} from "@/lib/effective-host";
import type { HostConfigDtoV2 } from "@/lib/host-config-v2";

function makeHost(
  partial: Partial<HostConfigDtoV2> & { clientCapabilities?: Record<string, unknown> },
): HostConfigDtoV2 {
  return {
    id: partial.id ?? "host-id",
    schemaVersion: 2,
    hostStyle: partial.hostStyle ?? "mcpjam",
    modelId: partial.modelId ?? "",
    systemPrompt: partial.systemPrompt ?? "",
    temperature: partial.temperature ?? 0.7,
    requireToolApproval: partial.requireToolApproval ?? false,
    serverIds: partial.serverIds ?? [],
    optionalServerIds: partial.optionalServerIds ?? [],
    connectionDefaults: partial.connectionDefaults ?? {
      headers: {},
      requestTimeout: 10000,
    },
    clientCapabilities: partial.clientCapabilities ?? {},
    hostContext: partial.hostContext ?? {},
    hostCapabilitiesOverride: partial.hostCapabilitiesOverride,
    chatUiOverride: partial.chatUiOverride,
    mcpProfile: partial.mcpProfile,
    serverConnectionOverrides: partial.serverConnectionOverrides,
  };
}

describe("resolveEffectiveHost", () => {
  it("prefers an explicit host over the project default", () => {
    const explicit = makeHost({ id: "explicit" });
    const fallback = makeHost({ id: "default" });
    expect(
      resolveEffectiveHost({
        explicitHostConfig: explicit,
        projectDefaultHostConfig: fallback,
      })?.id,
    ).toBe("explicit");
  });

  it("falls back to the project default when no explicit host is selected", () => {
    const fallback = makeHost({ id: "default" });
    expect(
      resolveEffectiveHost({
        explicitHostConfig: null,
        projectDefaultHostConfig: fallback,
      })?.id,
    ).toBe("default");
  });

  it("returns undefined during transient bootstrap (no host yet)", () => {
    expect(
      resolveEffectiveHost({
        explicitHostConfig: null,
        projectDefaultHostConfig: null,
      }),
    ).toBeUndefined();
  });
});

describe("resolveEffectiveClientCapabilities", () => {
  it("uses the host's clientCapabilities when no per-server override is set", () => {
    const host = makeHost({
      clientCapabilities: { sampling: {}, roots: { listChanged: true } },
    });
    const caps = resolveEffectiveClientCapabilities({
      host,
      serverConfig: {},
    });
    expect(caps).toEqual(
      expect.objectContaining({
        sampling: expect.any(Object),
        roots: { listChanged: true },
      }),
    );
  });

  it("per-server explicit clientCapabilities override the host", () => {
    const host = makeHost({
      clientCapabilities: { sampling: {} },
    });
    const caps = resolveEffectiveClientCapabilities({
      host,
      serverConfig: {
        clientCapabilities: { roots: { listChanged: false } },
      },
    });
    // Host caps (sampling) must NOT appear when per-server caps win verbatim.
    expect(caps).toEqual({ roots: { listChanged: false } });
  });

  it("merges per-server `capabilities` on top of host caps", () => {
    const host = makeHost({
      clientCapabilities: { sampling: {} },
    });
    const caps = resolveEffectiveClientCapabilities({
      host,
      serverConfig: {
        capabilities: { roots: { listChanged: true } },
      },
    });
    expect(caps).toEqual(
      expect.objectContaining({
        sampling: expect.any(Object),
        roots: { listChanged: true },
      }),
    );
  });

  it("falls back to SDK defaults when no host is supplied (bootstrap window)", () => {
    const caps = resolveEffectiveClientCapabilities({
      host: null,
      serverConfig: {},
    });
    // SDK defaults include the MCP UI extension — confirms we're not
    // silently dropping host caps in transient states.
    expect(caps).toEqual(
      expect.objectContaining({
        extensions: expect.any(Object),
      }),
    );
  });
});

describe("resolveServerInit", () => {
  it("returns the host's mcpProfile and connectionDefaults", () => {
    const host = makeHost({
      mcpProfile: {
        profileVersion: 1,
        initialize: { clientInfo: { name: "codex-mcp-client", version: "1" } },
      },
      connectionDefaults: { headers: { "x-test": "1" }, requestTimeout: 5000 },
    });
    const init = resolveServerInit({ host, serverConfig: {} });
    expect(init.mcpProfile?.initialize?.clientInfo).toEqual({
      name: "codex-mcp-client",
      version: "1",
    });
    expect(init.connectionDefaults).toEqual({
      headers: { "x-test": "1" },
      requestTimeout: 5000,
    });
  });

  it("picks up per-server connection overrides keyed by serverId", () => {
    const host = makeHost({
      serverConnectionOverrides: {
        "srv-1": { headersOverride: { "x-override": "yes" } },
      },
    });
    const init = resolveServerInit({
      host,
      serverConfig: {},
      serverId: "srv-1",
    });
    expect(init.perServerOverride?.headersOverride).toEqual({
      "x-override": "yes",
    });
  });

  it("omits per-server override when no serverId is given", () => {
    const host = makeHost({
      serverConnectionOverrides: {
        "srv-1": { headersOverride: { "x-override": "yes" } },
      },
    });
    const init = resolveServerInit({ host, serverConfig: {} });
    expect(init.perServerOverride).toBeUndefined();
  });
});

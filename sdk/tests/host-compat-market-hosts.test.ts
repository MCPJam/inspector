import { describe, expect, it } from "vitest";
import {
  buildMarketHostProfiles,
  bundledHostCompatCatalog,
  evaluateMarketHosts,
  MCP_APPS_FULL,
  MCP_APPS_CLAUDE,
  MCP_APPS_CHATGPT,
  type HostCompatToolsInput,
} from "../src/host-compat/index";
import {
  seedHostTemplate,
  type HostTemplateId,
} from "../src/host-config/templates/seed-host-template";

const toolsWith = (
  toolsMetadata: Record<string, Record<string, unknown>>
): HostCompatToolsInput => ({
  tools: Object.keys(toolsMetadata).map((name) => ({ name })),
  toolsMetadata,
});

const mcpAppsMeta = { ui: { resourceUri: "ui://widget" } };
const openaiMeta = { "openai/outputTemplate": "ui://widget" };

const profileFor = (id: string) =>
  buildMarketHostProfiles().find((p) => p.id === id);
const verdictFor = (
  id: string,
  tools: HostCompatToolsInput,
  options?: Parameters<typeof evaluateMarketHosts>[1]
) =>
  evaluateMarketHosts(tools, options).reports.find((r) => r.hostId === id)
    ?.verdict;

describe("buildMarketHostProfiles", () => {
  it("includes the catalog hosts (logo-free)", () => {
    const profiles = buildMarketHostProfiles();
    expect(profiles.map((p) => p.id).sort()).toEqual(
      Object.keys(bundledHostCompatCatalog().hostsById).sort()
    );
    expect(profiles.every((p) => !("logoSrc" in p))).toBe(true);
  });

  it("resolves the OpenAI-compat preset (chatgpt/copilot inject, others don't)", () => {
    expect(profileFor("chatgpt")?.rendersOpenAiApps).toBe(true);
    expect(profileFor("copilot")?.rendersOpenAiApps).toBe(true);
    expect(profileFor("claude")?.rendersOpenAiApps).toBe(false);
    expect(profileFor("goose")?.rendersOpenAiApps).toBe(false);
  });

  it("attaches a capability matrix only to rendering hosts", () => {
    expect(profileFor("claude")?.capabilities).toBeDefined();
    expect(profileFor("cursor")?.capabilities?.message).toBe(false);
    expect(profileFor("goose")?.capabilities?.serverTools).toBe(false);
    // Codex gained a matrix with the 2026-08-19 probe: it renders MCP Apps
    // via the same runtime as ChatGPT, so it is no longer headless.
    expect(profileFor("codex")?.capabilities).toBeDefined();
    // Headless hosts render nothing → no matrix.
    expect(profileFor("perplexity")?.capabilities).toBeUndefined();
  });

  it("keeps ChatGPT app capabilities faithful to the raw probe", () => {
    expect(profileFor("chatgpt")?.capabilities).toMatchObject({
      serverResources: true,
      logging: true,
      toolInputPartial: true,
      toolCancelled: true,
      resourceTeardown: true,
      cspResourceDomains: {
        script: true,
        stylesheet: true,
        image: true,
        font: true,
        media: true,
      },
      downloadFile: false,
    });
  });

  it("keeps Claude app capabilities faithful to the raw probe", () => {
    expect(profileFor("claude")?.capabilities).toMatchObject({
      availableDisplayModes: ["inline", "fullscreen"],
      cspConnectDomains: { fetch: true, xhr: true, websocket: true },
      cspResourceDomains: {
        script: true,
        stylesheet: true,
        image: true,
        font: true,
        media: true,
      },
      cspFrameDomains: false,
      cspBaseUriDomains: false,
      requestTeardown: false,
      toolCancelled: true,
    });
  });

  it("keeps Goose CSP findings faithful to the raw probe", () => {
    expect(profileFor("goose")?.capabilities).toMatchObject({
      cspConnectDomains: { fetch: false, xhr: false, websocket: false },
      cspResourceDomains: {
        script: false,
        stylesheet: false,
        image: false,
        font: false,
        media: false,
      },
      cspFrameDomains: false,
      cspBaseUriDomains: false,
      resourcePrefersBorder: true,
    });
  });

  it("carries each host's advertised protocol versions (or none)", () => {
    expect(profileFor("goose")?.supportedProtocolVersions).toEqual([
      "2025-03-26",
    ]);
    // Ladder-probed: both reach further back than the single version they
    // happen to negotiate by default, and Codex does not reach 2026-07-28.
    expect(profileFor("codex")?.supportedProtocolVersions).toEqual([
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
    ]);
    expect(profileFor("claude")?.supportedProtocolVersions).toEqual([
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
      "2026-07-28",
    ]);
    // MCPJam is the one template that deliberately advertises nothing: it is
    // the inspector itself rather than an emulated third-party client, so it
    // stays able to speak every revision (and its protocol check is skipped).
    expect(profileFor("mcpjam")?.supportedProtocolVersions).toBeUndefined();
  });

  it("keeps legacy initialize versions separate from modern catalog support", () => {
    // The catalog list spans both eras. The nested initialize list contains
    // only legacy revisions; modern support is discovered separately.
    for (const profile of buildMarketHostProfiles()) {
      const seeded = seedHostTemplate(profile.id as HostTemplateId);
      const initialize = seeded.mcpProfile?.initialize as
        | { supportedProtocolVersions?: string[] }
        | undefined;
      const legacyCatalogVersions =
        profile.supportedProtocolVersions?.filter(
          (version) => version < "2026-07-28"
        ) ?? [];
      expect(initialize?.supportedProtocolVersions ?? [], profile.id).toEqual(
        legacyCatalogVersions
      );
    }
  });

  it("exports deeply frozen capability matrices (can't poison verdicts)", () => {
    expect(Object.isFrozen(MCP_APPS_FULL)).toBe(true);
    expect(Object.isFrozen(MCP_APPS_FULL.availableDisplayModes)).toBe(true);
    expect(Object.isFrozen(MCP_APPS_CLAUDE.cspConnectDomains)).toBe(true);
    expect(Object.isFrozen(MCP_APPS_CLAUDE.cspResourceDomains)).toBe(true);
    expect(Object.isFrozen(MCP_APPS_CHATGPT.cspResourceDomains)).toBe(true);
    expect(() => {
      (MCP_APPS_FULL as { message?: boolean }).message = false;
    }).toThrow();
  });

  it("returns fresh copies — mutating one call doesn't affect the next", () => {
    const a = buildMarketHostProfiles();
    a.sort((x, y) => x.id.localeCompare(y.id));
    const claudeA = a.find((p) => p.id === "claude")!;
    claudeA.capabilities!.message = false;
    claudeA.capabilities!.cspConnectDomains!.fetch = false;
    claudeA.supportedProtocolVersions?.push("mutated");

    const b = buildMarketHostProfiles();
    // Order + nested state of a second call are unaffected by the mutation.
    expect(b.map((p) => p.id)).toEqual(
      Object.keys(bundledHostCompatCatalog().hostsById)
    );
    expect(b.find((p) => p.id === "claude")?.capabilities?.message).toBe(true);
    expect(
      b.find((p) => p.id === "claude")?.capabilities?.cspConnectDomains?.fetch
    ).toBe(true);
  });
});

describe("evaluateMarketHosts (real catalog verdicts)", () => {
  const widget = toolsWith({ w: mcpAppsMeta });
  const dualWidget = toolsWith({ w: { ...mcpAppsMeta, ...openaiMeta } });
  const clean = { widgetUsage: {} };

  it("a dual-bridge widget works in Claude and Codex, degrades headless", () => {
    expect(verdictFor("claude", dualWidget, clean)).toBe("works");
    // Was "degraded" until the 2026-08-19 probe showed Codex rendering MCP
    // Apps on the ChatGPT runtime. Asserted explicitly because this verdict
    // flip is the user-visible half of that catalog change.
    expect(verdictFor("codex", dualWidget, clean)).toBe("works");
    // Codex used to be this case's headless example; keep the dual-bridge
    // degrade path covered with a host that really is headless.
    expect(verdictFor("perplexity", dualWidget, clean)).toBe("degraded");
  });

  it("headless hosts degrade an MCP Apps widget to text", () => {
    for (const id of ["n8n", "perplexity", "cline"]) {
      expect(verdictFor(id, widget, clean)).toBe("degraded");
    }
  });

  it("ChatGPT renders MCP Apps widgets (works on a clean scan)", () => {
    expect(verdictFor("chatgpt", widget, clean)).toBe("works");
  });

  it("Goose works clean but degrades when a widget uses an unsupported API", () => {
    expect(verdictFor("goose", widget, clean)).toBe("works");
    expect(
      verdictFor("goose", widget, { widgetUsage: { message: ["w"] } })
    ).toBe("degraded");
  });

  it("Cursor degrades a widget that uses ui/message (Cursor lacks it)", () => {
    expect(
      verdictFor("cursor", widget, { widgetUsage: { message: ["w"] } })
    ).toBe("degraded");
    // Claude supports message → still works for the same widget.
    expect(
      verdictFor("claude", widget, { widgetUsage: { message: ["w"] } })
    ).toBe("works");
  });
});

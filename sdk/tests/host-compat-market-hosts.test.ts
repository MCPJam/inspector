import { describe, expect, it } from "vitest";
import {
  buildMarketHostProfiles,
  evaluateMarketHosts,
  MCP_APPS_FULL,
  type HostCompatToolsInput,
} from "../src/host-compat/index";
import {
  seedHostTemplate,
  type HostTemplateId,
} from "../src/host-config/templates/seed-host-template";

const toolsWith = (
  toolsMetadata: Record<string, Record<string, unknown>>,
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
  options?: Parameters<typeof evaluateMarketHosts>[1],
) => evaluateMarketHosts(tools, options).reports.find((r) => r.hostId === id)
  ?.verdict;

describe("buildMarketHostProfiles", () => {
  it("includes the 10 market hosts (logo-free)", () => {
    const profiles = buildMarketHostProfiles();
    expect(profiles.map((p) => p.id).sort()).toEqual(
      [
        "chatgpt",
        "claude",
        "cline",
        "codex",
        "copilot",
        "cursor",
        "goose",
        "mistral",
        "n8n",
        "perplexity",
      ].sort(),
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
    // Headless hosts render nothing → no matrix.
    expect(profileFor("codex")?.capabilities).toBeUndefined();
    expect(profileFor("perplexity")?.capabilities).toBeUndefined();
  });

  it("carries each host's advertised protocol versions (or none)", () => {
    expect(profileFor("goose")?.supportedProtocolVersions).toEqual([
      "2025-03-26",
    ]);
    expect(profileFor("codex")?.supportedProtocolVersions).toEqual([
      "2025-06-18",
    ]);
    // Templates that don't pin a version → undefined (protocol check skipped).
    expect(profileFor("claude")?.supportedProtocolVersions).toBeUndefined();
  });

  it("inlined protocol pins stay in sync with the host templates", () => {
    // The catalog stores supportedProtocolVersions directly (so the runtime
    // entry doesn't import the template machinery). This test IS the contract:
    // it derives the same fact from the template source of truth and fails if
    // the inlined pins drift — catching a template version bump that this file
    // wouldn't otherwise notice.
    for (const profile of buildMarketHostProfiles()) {
      const seeded = seedHostTemplate(profile.id as HostTemplateId);
      const initialize = seeded.mcpProfile?.initialize as
        | { supportedProtocolVersions?: string[] }
        | undefined;
      expect(profile.supportedProtocolVersions).toEqual(
        initialize?.supportedProtocolVersions,
      );
    }
  });

  it("exports deeply frozen capability matrices (can't poison verdicts)", () => {
    expect(Object.isFrozen(MCP_APPS_FULL)).toBe(true);
    expect(Object.isFrozen(MCP_APPS_FULL.availableDisplayModes)).toBe(true);
    expect(() => {
      (MCP_APPS_FULL as { message?: boolean }).message = false;
    }).toThrow();
  });

  it("returns fresh copies — mutating one call doesn't affect the next", () => {
    const a = buildMarketHostProfiles();
    a.sort((x, y) => x.id.localeCompare(y.id));
    const claudeA = a.find((p) => p.id === "claude")!;
    claudeA.capabilities!.message = false;
    claudeA.supportedProtocolVersions?.push("mutated");

    const b = buildMarketHostProfiles();
    // Order + nested state of a second call are unaffected by the mutation.
    expect(b.map((p) => p.id)).toEqual([
      "claude",
      "chatgpt",
      "mistral",
      "goose",
      "cursor",
      "copilot",
      "codex",
      "n8n",
      "perplexity",
      "cline",
    ]);
    expect(b.find((p) => p.id === "claude")?.capabilities?.message).toBe(true);
  });
});

describe("evaluateMarketHosts (real catalog verdicts)", () => {
  const widget = toolsWith({ w: mcpAppsMeta });
  const dualWidget = toolsWith({ w: { ...mcpAppsMeta, ...openaiMeta } });
  const clean = { widgetUsage: {} };

  it("a dual-bridge widget works in Claude but degrades in Codex (headless)", () => {
    expect(verdictFor("claude", dualWidget, clean)).toBe("works");
    expect(verdictFor("codex", dualWidget, clean)).toBe("degraded");
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
    expect(verdictFor("goose", widget, { widgetUsage: { message: ["w"] } })).toBe(
      "degraded",
    );
  });

  it("Cursor degrades a widget that uses ui/message (Cursor lacks it)", () => {
    expect(verdictFor("cursor", widget, { widgetUsage: { message: ["w"] } })).toBe(
      "degraded",
    );
    // Claude supports message → still works for the same widget.
    expect(verdictFor("claude", widget, { widgetUsage: { message: ["w"] } })).toBe(
      "works",
    );
  });
});

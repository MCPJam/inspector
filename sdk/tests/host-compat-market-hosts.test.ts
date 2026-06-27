import { describe, expect, it } from "vitest";
import {
  buildMarketHostProfiles,
  evaluateMarketHosts,
  type HostCompatToolsInput,
} from "../src/host-compat/index";

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

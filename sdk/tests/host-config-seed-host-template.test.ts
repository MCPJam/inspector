import { describe, it, expect } from "vitest";
import {
  seedHostTemplate,
  HOST_TEMPLATES,
  emptyHostConfigInputV2,
  type HostTemplateId,
} from "../src/host-config/templates/index.js";

const ALL_IDS: HostTemplateId[] = [
  "mcpjam",
  "claude",
  "claude-code",
  "chatgpt",
  "mistral",
  "goose",
  "cursor",
  "codex",
  "copilot",
  "vscode",
  "agentcore",
  "n8n",
  "perplexity",
];

describe("seedHostTemplate", () => {
  it("exposes one HOST_TEMPLATES entry per id", () => {
    expect(HOST_TEMPLATES.map((t) => t.id).sort()).toEqual(
      [...ALL_IDS].sort(),
    );
  });

  it("seeds a usable config for every template id and theme", () => {
    for (const id of ALL_IDS) {
      for (const theme of ["light", "dark"] as const) {
        const config = seedHostTemplate(id, { theme });
        expect(typeof config.hostStyle).toBe("string");
        expect(config.serverIds).toEqual([]);
        // clientCapabilities is always seeded (MCP UI extension etc.).
        expect(config.clientCapabilities).toBeTypeOf("object");
      }
    }
  });

  it("matches the documented model + style for the claude template", () => {
    const config = seedHostTemplate("claude", { theme: "dark" });
    expect(config.hostStyle).toBe("claude");
    expect(config.modelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("threads appVersion into the mcpjam template (and only it)", () => {
    const mcpjam = seedHostTemplate("mcpjam", { appVersion: "9.9.9" });
    const profile = mcpjam.mcpProfile as Record<string, any>;
    expect(profile.initialize.clientInfo.version).toBe("9.9.9");
    expect(profile.apps.uiInitialize.hostInfo.version).toBe("9.9.9");

    // The claude template pins a literal version — appVersion must not leak in.
    const claude = seedHostTemplate("claude", { appVersion: "9.9.9" });
    const claudeProfile = claude.mcpProfile as Record<string, any>;
    expect(claudeProfile.apps.uiInitialize.hostInfo.version).toBe("1.0.0");
  });

  it("reflects theme in the seeded hostContext styles", () => {
    const light = seedHostTemplate("mcpjam", { theme: "light" });
    const dark = seedHostTemplate("mcpjam", { theme: "dark" });
    expect((light.hostContext as any).theme).toBe("light");
    expect((dark.hostContext as any).theme).toBe("dark");
    expect(light.hostContext).not.toEqual(dark.hostContext);
  });

  it("emptyHostConfigInputV2 deep-clones inputs (no aliasing)", () => {
    const caps = { extensions: { foo: { bar: 1 } } };
    const config = emptyHostConfigInputV2({ clientCapabilities: caps });
    (config.clientCapabilities as any).extensions.foo.bar = 999;
    expect(caps.extensions.foo.bar).toBe(1);
  });

  // Golden-output guard. The committed snapshot was captured when these seeds
  // were extracted from the inspector client, at which point a client-side
  // parity test verified them byte-identical to the pre-refactor
  // `seedFromHostTemplate` implementation (running against the live client
  // modules). It now locks the seed output so any accidental drift in the
  // extracted seeds — a changed default, a dropped field — fails CI and must
  // be re-blessed deliberately. `appVersion` is pinned so the snapshot is
  // deterministic.
  it("seed output matches the committed golden snapshot", () => {
    const golden: Record<string, unknown> = {};
    for (const id of ALL_IDS) {
      for (const theme of ["light", "dark"] as const) {
        golden[`${id}/${theme}`] = seedHostTemplate(id, {
          theme,
          appVersion: "0.0.0-test",
        });
      }
    }
    expect(golden).toMatchSnapshot();
  });
});

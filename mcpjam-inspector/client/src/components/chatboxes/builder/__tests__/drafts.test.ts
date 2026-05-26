import { describe, expect, it } from "vitest";
import {
  draftToHostConfigInputV2,
  getDefaultHostedModelId,
  migrateBuilderDraft,
} from "../drafts";

describe("getDefaultHostedModelId", () => {
  it("defaults to GPT-5 Mini, not the first MCPJam model in the catalog (gpt-oss)", () => {
    expect(getDefaultHostedModelId()).toBe("openai/gpt-5-mini");
    expect(getDefaultHostedModelId()).not.toBe("openai/gpt-oss-120b");
  });
});

describe("migrateBuilderDraft", () => {
  it("returns null for null/undefined input", () => {
    expect(migrateBuilderDraft(null)).toBeNull();
    expect(migrateBuilderDraft(undefined)).toBeNull();
  });

  it("fills missing fields from the blank starter for older drafts", () => {
    const oldShape = {
      name: "Pre-existing draft",
      hostStyle: "claude" as const,
      systemPrompt: "Hello",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      selectedServerIds: ["srv-1", "srv-2"],
      // Missing: optionalServerIds, chatUi (welcome/feedback), mode, etc.
    };
    const migrated = migrateBuilderDraft(oldShape);
    expect(migrated).not.toBeNull();
    expect(migrated!.selectedServerIds).toEqual(["srv-1", "srv-2"]);
    expect(migrated!.optionalServerIds).toEqual([]);
    expect(migrated!.chatUi.surfaces.welcome).toBeDefined();
    expect(migrated!.chatUi.surfaces.feedback).toBeDefined();
    expect(migrated!.mode).toBeDefined();
    expect(migrated!.allowGuestAccess).toBeDefined();
    expect(migrated!.name).toBe("Pre-existing draft");
  });

  it("rehydrates legacy top-level welcomeDialog/feedbackDialog into chatUi.surfaces", () => {
    // sessionStorage drafts written before the chatUi envelope landed carry
    // welcome/feedback at the top level. The migrator must fold them into
    // the new shape so an in-flight builder draft doesn't lose its body or
    // cadence the moment the new code ships.
    const legacy = {
      name: "Mid-edit draft",
      hostStyle: "claude" as const,
      systemPrompt: "Sys",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      selectedServerIds: ["srv-1"],
      optionalServerIds: [],
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      welcomeDialog: { enabled: false, body: "Half-written welcome" },
      feedbackDialog: {
        enabled: true,
        everyNToolCalls: 4,
        promptHint: "Any blockers?",
      },
    };
    const migrated = migrateBuilderDraft(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated!.chatUi.surfaces.welcome).toEqual({
      enabled: false,
      body: "Half-written welcome",
    });
    expect(migrated!.chatUi.surfaces.feedback).toEqual({
      enabled: true,
      everyNToolCalls: 4,
      promptHint: "Any blockers?",
    });
    // Orphan top-level keys must not ride along on the migrated draft.
    expect(migrated as unknown as Record<string, unknown>).not.toHaveProperty(
      "welcomeDialog",
    );
    expect(migrated as unknown as Record<string, unknown>).not.toHaveProperty(
      "feedbackDialog",
    );
  });

  it("prefers the new chatUi shape over legacy keys when both are present", () => {
    const both = {
      name: "Both shapes",
      hostStyle: "claude" as const,
      systemPrompt: "Sys",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      selectedServerIds: [],
      optionalServerIds: [],
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      welcomeDialog: { enabled: false, body: "stale" },
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "fresh" },
        },
      },
    };
    const migrated = migrateBuilderDraft(both);
    expect(migrated!.chatUi.surfaces.welcome).toEqual({
      enabled: true,
      body: "fresh",
    });
  });

  it("preserves complete drafts at the field level", () => {
    const draft = {
      name: "Complete",
      description: "desc",
      hostStyle: "chatgpt" as const,
      systemPrompt: "Sys",
      modelId: "openai/gpt-5-mini",
      temperature: 0.42,
      requireToolApproval: true,
      allowGuestAccess: false,
      mode: "invited_only" as const,
      selectedServerIds: ["a", "b"],
      optionalServerIds: ["b"],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "hi" },
          feedback: {
            enabled: true,
            everyNToolCalls: 2,
            promptHint: "feedback?",
          },
        },
      },
    };
    const migrated = migrateBuilderDraft(draft);
    expect(migrated).toEqual(draft);
  });
});

describe("draftToHostConfigInputV2", () => {
  it("builds a v2 input from a draft, defaulting connection settings when no project default is supplied", () => {
    const draft = {
      name: "n",
      description: "",
      hostStyle: "claude" as const,
      systemPrompt: "Sys",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "invited_only" as const,
      selectedServerIds: ["srv-1"],
      optionalServerIds: ["srv-1"],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "" },
          feedback: { enabled: true, everyNToolCalls: 1, promptHint: "" },
        },
      },
    };
    const input = draftToHostConfigInputV2(draft);
    expect(input.hostStyle).toBe("claude");
    expect(input.modelId).toBe("openai/gpt-5-mini");
    expect(input.systemPrompt).toBe("Sys");
    expect(input.serverIds).toEqual(["srv-1"]);
    expect(input.optionalServerIds).toEqual(["srv-1"]);
    expect(input.connectionDefaults.headers).toEqual({});
    expect(input.connectionDefaults.requestTimeout).toBeGreaterThan(0);
  });

  it("uses the project default's connection portion when supplied", () => {
    const draft = {
      name: "n",
      description: "",
      hostStyle: "claude" as const,
      systemPrompt: "",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "invited_only" as const,
      selectedServerIds: [],
      optionalServerIds: [],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "" },
          feedback: { enabled: true, everyNToolCalls: 1, promptHint: "" },
        },
      },
    };
    const input = draftToHostConfigInputV2(draft, {
      connectionDefaults: {
        headers: { "x-project": "abc" },
        requestTimeout: 5_000,
      },
      clientCapabilities: { custom: true },
      hostContext: { theme: "dark" },
    });
    expect(input.connectionDefaults.headers).toEqual({ "x-project": "abc" });
    expect(input.connectionDefaults.requestTimeout).toBe(5_000);
    expect(input.clientCapabilities).toEqual({ custom: true });
    expect(input.hostContext).toEqual({ theme: "dark" });
  });

  it("inherits mcpProfile.apps.mcpAppsOverrides from the project default (matrix override survives chatbox creation)", () => {
    // The MCP Apps spec-bridge matrix lives under
    // mcpProfile.apps.mcpAppsOverrides. draftToHostConfigInputV2 must
    // pass the whole mcpProfile envelope through from the project
    // default — otherwise a new chatbox created from a project that
    // narrowed its spec-bridge surface (e.g. via "Match Copilot"
    // preset chip) would silently re-advertise the full surface to
    // widgets. Same guarantee the hostCapabilitiesOverride
    // inheritance test enforces for the legacy override.
    const draft = {
      name: "n",
      description: "",
      hostStyle: "claude" as const,
      systemPrompt: "",
      modelId: "openai/gpt-5-mini",
      temperature: 0.5,
      requireToolApproval: false,
      allowGuestAccess: false,
      mode: "invited_only" as const,
      selectedServerIds: [],
      optionalServerIds: [],
      chatUi: {
        surfaces: {
          welcome: { enabled: true, body: "" },
          feedback: { enabled: true, everyNToolCalls: 1, promptHint: "" },
        },
      },
    };
    const input = draftToHostConfigInputV2(draft, {
      connectionDefaults: { headers: {}, requestTimeout: 30_000 },
      clientCapabilities: {},
      hostContext: {},
      mcpProfile: {
        profileVersion: 1,
        apps: {
          mcpAppsOverrides: { serverResources: false, logging: false },
        },
      },
    });
    expect(input.mcpProfile?.apps?.mcpAppsOverrides).toEqual({
      serverResources: false,
      logging: false,
    });
  });
});

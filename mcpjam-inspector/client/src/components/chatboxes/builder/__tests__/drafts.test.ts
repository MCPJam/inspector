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
      // Missing: optionalServerIds, welcomeDialog, feedbackDialog, mode, etc.
    };
    const migrated = migrateBuilderDraft(oldShape);
    expect(migrated).not.toBeNull();
    expect(migrated!.selectedServerIds).toEqual(["srv-1", "srv-2"]);
    expect(migrated!.optionalServerIds).toEqual([]);
    expect(migrated!.welcomeDialog).toBeDefined();
    expect(migrated!.feedbackDialog).toBeDefined();
    expect(migrated!.mode).toBeDefined();
    expect(migrated!.allowGuestAccess).toBeDefined();
    expect(migrated!.name).toBe("Pre-existing draft");
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
      welcomeDialog: { enabled: true, body: "hi" },
      feedbackDialog: {
        enabled: true,
        everyNToolCalls: 2,
        promptHint: "feedback?",
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
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
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
      welcomeDialog: { enabled: true, body: "" },
      feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
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
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  buildTestCaseModelOptions,
  getDefaultTestCaseModelValue,
  getPersistedTestCaseModelValue,
  prepareSingleTestCaseRun,
  projectHostConfigRunOverride,
  resolveSelectedTestCaseModelValue,
  setPersistedTestCaseModelValue,
} from "../single-test-case-runner";

describe("single-test-case-runner", () => {
  const suite = {
    environment: {
      servers: ["asana"],
    },
  };

  const testCase = {
    _id: "case-1",
    models: [{ provider: "openai", model: "gpt-4o" }],
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the first configured case model", () => {
    expect(getDefaultTestCaseModelValue(testCase)).toBe("openai/gpt-4o");
  });

  it("builds model options from all available models", () => {
    const modelOptions = buildTestCaseModelOptions(
      [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          provider: "openai",
        },
      ],
      testCase,
    );

    expect(modelOptions.map((option) => option.label)).toEqual([
      "Claude Haiku 4.5",
      "GPT-5 Mini",
      "gpt-4o",
    ]);
  });

  it("prefers the persisted model selection when it is available", () => {
    const modelOptions = buildTestCaseModelOptions(
      [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          provider: "openai",
        },
      ],
      testCase,
    );

    setPersistedTestCaseModelValue(
      "case-1",
      "anthropic/anthropic/claude-haiku-4.5",
    );

    expect(getPersistedTestCaseModelValue("case-1")).toBe(
      "anthropic/anthropic/claude-haiku-4.5",
    );
    expect(
      resolveSelectedTestCaseModelValue({
        testCaseId: "case-1",
        testCase,
        modelOptions,
      }),
    ).toBe("anthropic/anthropic/claude-haiku-4.5");
  });

  it("prepares a one-off case run request", async () => {
    const prepared = await prepareSingleTestCaseRun({
      projectId: "project-1",
      suite,
      testCase,
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
    });

    expect(prepared).toEqual({
      modelValue: "openai/gpt-4o",
      request: {
        projectId: "project-1",
        testCaseId: "case-1",
        model: "gpt-4o",
        provider: "openai",
        serverIds: ["asana"],
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("uses the explicitly selected model when provided", async () => {
    const prepared = await prepareSingleTestCaseRun({
      projectId: "project-1",
      suite,
      testCase,
      selectedModel: "anthropic/anthropic/claude-haiku-4.5",
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
    });

    expect(prepared).toEqual({
      modelValue: "anthropic/anthropic/claude-haiku-4.5",
      request: {
        projectId: "project-1",
        testCaseId: "case-1",
        model: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
        serverIds: ["asana"],
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("does not require a user API key for MCPJam-provided models stored without the provider prefix", async () => {
    const prepared = await prepareSingleTestCaseRun({
      projectId: "project-1",
      suite,
      testCase: {
        _id: "case-1",
        models: [{ provider: "anthropic", model: "claude-haiku-4.5" }],
      },
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
    });

    expect(prepared).toEqual({
      modelValue: "anthropic/claude-haiku-4.5",
      request: {
        projectId: "project-1",
        testCaseId: "case-1",
        model: "claude-haiku-4.5",
        provider: "anthropic",
        serverIds: ["asana"],
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("throws when a case has no configured model", async () => {
    await expect(
      prepareSingleTestCaseRun({
        projectId: "project-1",
        suite,
        testCase: {
          _id: "case-1",
          models: [],
        },
        getAccessToken: vi.fn().mockResolvedValue("token-123"),
        getToken: vi.fn().mockReturnValue("openai-key"),
        hasToken: vi.fn().mockReturnValue(true),
      }),
    ).rejects.toThrow("Add a model first");
  });
});

describe("projectHostConfigRunOverride", () => {
  // The projection from a full `HostConfigInputV2` into the subset
  // sent to the server as the per-Run hostConfig snapshot. The
  // projection MUST include `mcpProfile` whole so the SEP-1865
  // `app.*` spec-bridge matrix (under
  // `mcpProfile.apps.mcpAppsOverrides`) round-trips through eval
  // runs — same guarantee the existing `hostCapabilitiesOverride`
  // projection already provides for the legacy vendor-trait
  // override. Without this, a host configured to simulate Microsoft
  // 365 Copilot's M365 subset would have its per-run snapshots
  // silently re-advertise the full spec surface, making eval runs
  // not reflect the production host's behavior.
  it("includes mcpProfile.apps.mcpAppsOverrides verbatim", () => {
    const input = emptyHostConfigInputV2({ hostStyle: "copilot" });
    input.mcpProfile = {
      profileVersion: 1,
      apps: {
        mcpAppsOverrides: {
          serverResources: false,
          logging: false,
          availableDisplayModes: ["fullscreen"],
        },
      },
    };
    const projected = projectHostConfigRunOverride(input);
    const profile = projected.mcpProfile as
      | { apps?: { mcpAppsOverrides?: unknown } }
      | undefined;
    expect(profile?.apps?.mcpAppsOverrides).toEqual({
      serverResources: false,
      logging: false,
      availableDisplayModes: ["fullscreen"],
    });
  });

  it("includes the legacy hostCapabilitiesOverride verbatim (sibling field, not subsumed by mcpProfile)", () => {
    // The two override paths live on different fields (top-level vs
    // nested under mcpProfile). The projection carries both so saved
    // eval runs match what the resolver advertises today even for
    // not-yet-migrated configs.
    const input = emptyHostConfigInputV2({ hostStyle: "claude" });
    input.hostCapabilitiesOverride = { openLinks: {}, serverTools: {} };
    const projected = projectHostConfigRunOverride(input);
    expect(projected.hostCapabilitiesOverride).toEqual({
      openLinks: {},
      serverTools: {},
    });
  });

  it("omits both override paths when neither is set (clean preset run)", () => {
    const input = emptyHostConfigInputV2({ hostStyle: "claude" });
    const projected = projectHostConfigRunOverride(input);
    expect(projected.mcpProfile).toBeUndefined();
    expect(projected.hostCapabilitiesOverride).toBeUndefined();
  });
});

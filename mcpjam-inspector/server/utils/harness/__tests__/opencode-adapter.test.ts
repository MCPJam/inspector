/**
 * Hosted OpenCode: MCPJam host-executed tools, brokered Anthropic, no guest
 * or local path, title/compaction pinned to the leased model.
 */
import { describe, expect, it, vi } from "vitest";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import {
  buildBrokerDummyAuth,
  getHarnessAdapter,
  registeredHarnessIds,
} from "../registry.js";
import { createOpenCodeHarness } from "../opencode-adapter.js";
import { toOpenCodeModel, toOpenCodeNativeModel } from "../runtime-model-ids.js";
import { harnessToolApprovalRefusalReason } from "../harness-availability.js";

vi.mock("@ai-sdk/harness-opencode", async (original) => {
  const actual =
    await original<typeof import("@ai-sdk/harness-opencode")>();
  return { ...actual, createOpenCode: vi.fn(actual.createOpenCode) };
});

describe("the OpenCode adapter", () => {
  it("is registered as a brokered host-executed runtime", () => {
    const adapter = getHarnessAdapter("opencode");
    expect(adapter.id).toBe("opencode");
    expect(adapter.modelAccess).toBe("broker");
    expect(adapter.mcpDelivery).toBe("mcpjam");
    expect(adapter.supportsHostExecutedToolApproval).toBe(true);
    expect(adapter.supportsMcpToolApproval).toBe(false);
    expect(adapter.supportsNativeToolApproval).toBe(true);
    expect(adapter.supportsSkills).toBe(false);
    expect(adapter.forwardingRuntime).toBeUndefined();
    expect(adapter.liveApprovalRuntime).toBe(true);
    expect(registeredHarnessIds()).toContain("opencode");
  });

  it("uses dummy Anthropic broker auth, never a warm-agent close header", () => {
    const auth = buildBrokerDummyAuth("opencode", "https://proxy.example");
    expect(auth.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(auth.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    expect(auth).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(auth).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(
      buildBrokerDummyAuth("opencode", "https://proxy.example", true),
    ).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
  });

  it("admits an approval-gated host someone can answer", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter: getHarnessAdapter("opencode"),
        requireToolApproval: true,
        hasSelectedMcpServers: true,
        unattended: false,
      }),
    ).toBeUndefined();
    expect(
      harnessToolApprovalRefusalReason({
        adapter: getHarnessAdapter("opencode"),
        requireToolApproval: true,
        hasSelectedMcpServers: true,
        unattended: true,
      }),
    ).toMatch(/evals or swarms/i);
  });

  it("pins title and compaction to the leased Anthropic model", () => {
    vi.mocked(createOpenCode).mockClear();
    createOpenCodeHarness({
      modelId: "anthropic/claude-haiku-4.5",
      auth: buildBrokerDummyAuth("opencode", "https://broker.example"),
    });
    expect(vi.mocked(createOpenCode).mock.lastCall?.[0]).toMatchObject({
      provider: "anthropic",
      openCodeConfig: {
        agent: {
          title: { model: "anthropic/claude-haiku-4-5" },
          compaction: { model: "anthropic/claude-haiku-4-5" },
        },
      },
    });
  });

  it("maps Gateway and native Anthropic ids onto OpenCode's hyphenated spelling", () => {
    expect(toOpenCodeModel("anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(toOpenCodeModel("openai/gpt-5.5")).toBeUndefined();
    expect(
      toOpenCodeNativeModel("anthropic/claude-haiku-4.5", {
        profile: "anthropic-native",
        nativeModelId: "claude-haiku-4-5",
      }),
    ).toBe("anthropic/claude-haiku-4-5");
    expect(
      toOpenCodeNativeModel("anthropic/claude-haiku-4.5", {
        profile: "anthropic-native",
        nativeModelId: "claude-haiku-4.5",
      }),
    ).toBe("anthropic/claude-haiku-4-5");
  });
});

/**
 * Hosted OpenCode: MCPJam host-executed tools, brokered Anthropic, no guest
 * or local path, title/compaction pinned to the leased model.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import {
  buildBrokerDummyAuth,
  getHarnessAdapter,
  opencodeAnthropicBrokerBaseUrl,
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
  it("probes the CLI under the harness state directory, not the session workdir", () => {
    const cmd = getHarnessAdapter("opencode").runtimeVersionCommand!;
    const expected =
      '"$HOME/.ai-sdk-harness/.harness-bootstrap/opencode/node_modules/.bin/opencode" --version';
    expect(cmd("/home/user")).toBe(expected);
    expect(cmd("/home/user/$(id)")).toBe(expected);
  });

  it("is registered as a brokered host-executed runtime", () => {
    const adapter = getHarnessAdapter("opencode");
    expect(adapter.id).toBe("opencode");
    expect(adapter.modelAccess).toBe("broker");
    expect(adapter.mcpDelivery).toBe("mcpjam");
    expect(adapter.supportsHostExecutedToolApproval).toBe(true);
    expect(adapter.supportsMcpToolApproval).toBe(false);
    expect(adapter.supportsNativeToolApproval).toBe(true);
    expect(adapter.supportsSkills).toBe(true);
    expect(adapter.forwardingRuntime).toBeUndefined();
    expect(adapter.liveApprovalRuntime).toBe(true);
    expect(registeredHarnessIds()).toContain("opencode");
  });

  it("uses dummy Anthropic broker auth, never a warm-agent close header", () => {
    const auth = buildBrokerDummyAuth("opencode", "https://proxy.example");
    expect(auth.ANTHROPIC_BASE_URL).toBe("https://proxy.example/v1");
    expect(auth.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    expect(auth).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(auth).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(
      buildBrokerDummyAuth("opencode", "https://proxy.example", true),
    ).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    expect(opencodeAnthropicBrokerBaseUrl("https://proxy.example/")).toBe(
      "https://proxy.example/v1",
    );
    expect(opencodeAnthropicBrokerBaseUrl("https://proxy.example/v1")).toBe(
      "https://proxy.example/v1",
    );
  });

  it("builds an OpenCode broker base URL that already includes /v1", async () => {
    const seen: string[] = [];
    const server: Server = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    try {
      const leaseBase = `http://127.0.0.1:${port}/web/harness/model-proxy/anthropic`;
      const auth = buildBrokerDummyAuth("opencode", leaseBase);
      // This appends `/messages` itself. It checks MCPJam's dummy base URL,
      // not what the OpenCode binary appends (that evidence is the 1.18.34 run).
      const outgoing = `${String(auth.ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/messages`;
      const response = await fetch(outgoing, {
        method: "POST",
        body: "{}",
      });
      expect(response.ok).toBe(true);
      expect(seen).toEqual(["/web/harness/model-proxy/anthropic/v1/messages"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("keeps host-tool requests open while a human decides an approval", () => {
    vi.mocked(createOpenCode).mockClear();
    createOpenCodeHarness({
      modelId: "anthropic/claude-haiku-4.5",
      auth: buildBrokerDummyAuth("opencode", "https://broker.example"),
    });
    expect(
      vi.mocked(createOpenCode).mock.lastCall?.[0]?.openCodeConfig,
    ).toMatchObject({ experimental: { mcp_timeout: 30 * 60 * 1000 } });
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

/**
 * Dispatch regression for `streamWebChatTurn`: the MCPJam-vs-org-BYOK branch
 * must canonicalize the model id WITH the provider, exactly like the route's
 * harness preflight does. Before the fix, a bare hosted id (`gpt-5-nano` +
 * `openai`) passed the preflight (which supplies the provider) but the
 * dispatch recomputed `isMCPJam` provider-blind — so the turn silently
 * branched into org-BYOK handling and skipped `runHarnessTurn` even though
 * `persist.harness` was set.
 *
 * The stream handlers are mocked; these are pure dispatch tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  mcpjamFree: vi.fn(async () => new Response("mcpjam")),
  hostedOrg: vi.fn(async () => new Response("org-hosted")),
  localOrg: vi.fn(async () => new Response("org-local")),
}));

vi.mock("../mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handlers.mcpjamFree,
  warnIfChatAbortSignalMissing: vi.fn(),
}));

vi.mock("../org-model-stream-handler.js", () => ({
  handleHostedOrgChatModel: handlers.hostedOrg,
  handleLocalOrgChatModel: handlers.localOrg,
}));

vi.mock("../org-model-config.js", () => ({
  deriveOrgProviderKey: vi.fn(() => ({ ok: true, key: "openai" })),
  isLocalRuntimeEligible: vi.fn(() => false),
  resolveOrgProviderRuntime: vi.fn(),
}));

vi.mock("../chat-v2-orchestration.js", () => ({
  prepareChatV2: vi.fn(async () => ({
    allTools: {},
    enhancedSystemPrompt: "",
    resolvedTemperature: undefined,
    scrubMessages: (m: unknown[]) => m,
    progressivePlan: undefined,
    discoveryState: undefined,
  })),
  buildWidgetModelContextSystemPrompt: vi.fn(() => ""),
}));

vi.mock("../mcp-tool-result-model-output.js", () => ({
  convertToMcpjamModelMessages: vi.fn(async () => []),
}));

vi.mock("../harness/harness-proxy-strategy.js", () => ({
  resolveWebAuthorizedHarnessStrategy: vi.fn(() => ({
    plane: "web-authorized",
    mode: "direct",
    publicBaseUrl: "https://inspector.example.com",
  })),
}));

import { streamWebChatTurn } from "../web-chat-turn";

function args(
  modelDefinition: {
    id: string;
    provider: string;
    name?: string;
    hosted?: boolean;
  },
  /** `null` = a non-harness host. */
  harness: "claude-code" | null = "claude-code",
  prepareExtra: Record<string, unknown> = {},
) {
  const c = {
    req: {
      raw: { headers: new Headers(), signal: undefined },
      header: () => undefined,
    },
  } as never;
  return {
    manager: {
      disconnectAllServers: vi.fn(async () => {}),
      hasServer: () => false,
    } as never,
    prepare: {
      selectedServerIds: [],
      modelDefinition: { name: "m", ...modelDefinition } as never,
      uiMessages: [],
      ...prepareExtra,
    },
    persist: {
      chatSessionId: undefined,
      projectId: "p1",
      sourceType: "direct" as const,
      origin: "playground" as const,
      originalMessages: [],
      selectedServerIds: [],
      ...(harness ? { harness } : {}),
    },
    runtime: {
      authHeader: "Bearer t",
      clientIp: null,
      abortSignal: undefined,
      c,
    },
  };
}

describe("streamWebChatTurn model dispatch", () => {
  beforeEach(() => {
    handlers.mcpjamFree.mockClear();
    handlers.hostedOrg.mockClear();
    handlers.localOrg.mockClear();
    // stubEnv (not a bare assignment) so the value is restored after each
    // test and can't leak into suites that assert CONVEX_HTTP_URL is unset.
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([false, true])("forwards local chat workload and stops on refusal (%s)", async (refused) => {
    const config = await import("../org-model-config.js");
    const orchestration = await import("../chat-v2-orchestration.js");
    const conversion = await import("../mcp-tool-result-model-output.js");
    vi.mocked(config.deriveOrgProviderKey).mockReturnValueOnce({ ok: true, key: "ollama" });
    vi.mocked(config.isLocalRuntimeEligible).mockReturnValueOnce(true);
    vi.mocked(orchestration.prepareChatV2).mockResolvedValueOnce({
      allTools: { search: { description: "search", inputSchema: {} } },
      enhancedSystemPrompt: "", scrubMessages: (m: unknown[]) => m,
    } as never);
    vi.mocked(conversion.convertToMcpjamModelMessages).mockResolvedValueOnce([
      { role: "user", content: [{ type: "image", image: "private-image" }] },
    ]);
    if (refused) vi.mocked(config.resolveOrgProviderRuntime).mockRejectedValueOnce(new Error("tools unsupported"));
    else vi.mocked(config.resolveOrgProviderRuntime).mockResolvedValueOnce({ runtimeLocation: "local", provider: { providerKey: "ollama", baseUrl: "http://localhost:11434", modelIds: ["llama3"] } });
    const pending = streamWebChatTurn(args({ id: "llama3", provider: "ollama", hosted: false }, null) as never);
    if (refused) await expect(pending).rejects.toThrow("tools unsupported");
    else await pending;
    expect(config.resolveOrgProviderRuntime).toHaveBeenLastCalledWith("p1", "ollama", "llama3", expect.anything(), {
      modelWorkload: { purpose: "chat", hasTools: true, hasUserImages: true },
    });
    expect(handlers.localOrg).toHaveBeenCalledTimes(refused ? 0 : 1);
  });

  it("routes a BARE MCPJam-hosted id + provider to the MCPJam path (harness runs)", async () => {
    await streamWebChatTurn(
      args({ id: "gpt-5-nano", provider: "openai" }) as never,
    );
    expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
    expect(handlers.hostedOrg).not.toHaveBeenCalled();
    const opts = handlers.mcpjamFree.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(opts.harness).toBe("claude-code");
  });

  // The SAME `(id, provider)` pair as the bare hosted case above, but sent from
  // the picker's "Your providers" row: the user chose their own OpenAI key.
  // Only the explicit `hosted: false` stamp tells the two apart.
  it("routes a bare id the picker stamped hosted: false to the org-BYOK path", async () => {
    await streamWebChatTurn(
      args(
        { id: "gpt-5-nano", provider: "openai", hosted: false },
        null,
      ) as never,
    );
    expect(handlers.hostedOrg).toHaveBeenCalledTimes(1);
    expect(handlers.mcpjamFree).not.toHaveBeenCalled();
  });

  it("routes a prefixed MCPJam id to the MCPJam path (sanity)", async () => {
    await streamWebChatTurn(
      args({ id: "openai/gpt-5-nano", provider: "openai" }) as never,
    );
    expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
    expect(handlers.hostedOrg).not.toHaveBeenCalled();
  });

  it("routes a non-MCPJam model to the org-BYOK path", async () => {
    await streamWebChatTurn(
      args({ id: "gpt-4.1-mini-custom", provider: "openai" }, null) as never,
    );
    expect(handlers.hostedOrg).toHaveBeenCalledTimes(1);
    expect(handlers.mcpjamFree).not.toHaveBeenCalled();
  });

  // A HARNESS turn never takes the org-BYOK branch: that branch runs the
  // emulated engine, which would then be reported under the harness's name.
  it.each([
    [{ id: "gpt-5-nano", provider: "openai", hosted: false }],
    [{ id: "gpt-4.1-mini-custom", provider: "openai" }],
  ])("refuses a harness turn on a BYOK model (%o) instead of emulating", async (model) => {
    await expect(streamWebChatTurn(args(model) as never)).rejects.toThrow(
      /This host runs the claude-code harness, which isn't available: the Claude Code harness only runs MCPJam-provided models/,
    );
    expect(handlers.hostedOrg).not.toHaveBeenCalled();
    expect(handlers.localOrg).not.toHaveBeenCalled();
    expect(handlers.mcpjamFree).not.toHaveBeenCalled();
  });

  describe("the saved selection decides the rail (routingSelection)", () => {
    const none = { provider: "none", model: "none" } as const;

    it("a STORED legacy selection keeps a hosted id off MCPJam credits", async () => {
      await streamWebChatTurn(
        args({ id: "openai/gpt-5-nano", provider: "openai" }, null, {
          routingSelection: { source: "legacy", modelId: "openai/gpt-5-nano" },
        }) as never,
      );
      expect(handlers.hostedOrg).toHaveBeenCalledTimes(1);
      expect(handlers.mcpjamFree).not.toHaveBeenCalled();
    });

    it("an org selection takes the org path and is forwarded to the resolve", async () => {
      const config = await import("../org-model-config.js");
      vi.mocked(config.deriveOrgProviderKey).mockReturnValueOnce({
        ok: true,
        key: "ollama",
      });
      vi.mocked(config.isLocalRuntimeEligible).mockReturnValueOnce(true);
      vi.mocked(config.resolveOrgProviderRuntime).mockResolvedValueOnce({
        runtimeLocation: "cloud",
        providerKey: "ollama",
      });
      const org = {
        modelId: "ollama/llama3",
        source: "org" as const,
        connectionRef: { kind: "orgProvider" as const, id: "orgprov_1" },
        fallback: none,
      };
      await streamWebChatTurn(
        args({ id: "ollama/llama3", provider: "ollama" }, null, {
          routingSelection: org,
        }) as never,
      );
      expect(config.resolveOrgProviderRuntime).toHaveBeenLastCalledWith(
        "p1",
        "ollama",
        "ollama/llama3",
        expect.anything(),
        expect.objectContaining({ modelSelection: org }),
      );
      expect(handlers.hostedOrg).toHaveBeenCalledTimes(1);
      expect(handlers.mcpjamFree).not.toHaveBeenCalled();
    });

    it("a hosted selection takes MCPJam /stream even where the hosted list would not", async () => {
      await streamWebChatTurn(
        args({ id: "vendor/brand-new", provider: "openai" }, null, {
          routingSelection: {
            modelId: "vendor/brand-new",
            source: "hosted",
            fallback: none,
          },
        }) as never,
      );
      expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
      expect(handlers.hostedOrg).not.toHaveBeenCalled();
    });

    it("no selection: the hosted-list check decides, unchanged", async () => {
      await streamWebChatTurn(
        args({ id: "openai/gpt-5-nano", provider: "openai" }, null) as never,
      );
      expect(handlers.mcpjamFree).toHaveBeenCalledTimes(1);
    });
  });

  describe("reasoning effort", () => {
    it("MCPJam path: forwards the effort to the hosted engine and to prepare", async () => {
      const orchestration = await import("../chat-v2-orchestration.js");
      vi.mocked(orchestration.prepareChatV2).mockClear();
      await streamWebChatTurn(
        args({ id: "openai/gpt-5-nano", provider: "openai" }, null, {
          reasoningEffort: "high",
        }) as never,
      );
      const opts = handlers.mcpjamFree.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(opts.reasoningEffort).toBe("high");
      expect(
        vi.mocked(orchestration.prepareChatV2).mock.calls[0]?.[0],
      ).toMatchObject({ reasoningEffort: "high" });
    });

    it("no effort leaves the handler options without the field", async () => {
      await streamWebChatTurn(
        args({ id: "openai/gpt-5-nano", provider: "openai" }, null) as never,
      );
      const opts = handlers.mcpjamFree.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect("reasoningEffort" in opts).toBe(false);
    });

    it("org cloud: forwards the effort to the hosted org handler", async () => {
      await streamWebChatTurn(
        args({ id: "gpt-4.1-mini-custom", provider: "openai" }, null, {
          reasoningEffort: "low",
        }) as never,
      );
      const opts = handlers.hostedOrg.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(opts.reasoningEffort).toBe("low");
    });

    async function localOrg(
      providerKey: string,
      model: { id: string; provider: string },
      prepareExtra: Record<string, unknown>,
    ) {
      const config = await import("../org-model-config.js");
      vi.mocked(config.deriveOrgProviderKey).mockReturnValueOnce({
        ok: true,
        key: providerKey,
      } as never);
      vi.mocked(config.isLocalRuntimeEligible).mockReturnValueOnce(true);
      vi.mocked(config.resolveOrgProviderRuntime).mockResolvedValueOnce({
        runtimeLocation: "local",
        provider: { providerKey, baseUrl: "http://x", modelIds: [model.id] },
      } as never);
      return streamWebChatTurn(
        args({ ...model, hosted: false }, null, prepareExtra) as never,
      );
    }

    it("org local: applies the effort as provider options", async () => {
      await localOrg(
        "openai",
        { id: "gpt-5.1", provider: "openai" },
        { reasoningEffort: "high" },
      );
      const opts = handlers.localOrg.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(opts.providerOptions).toEqual({
        openai: { reasoningEffort: "high" },
      });
    });

    it("org local: refuses a provider with no effort control before any spend", async () => {
      await expect(
        localOrg(
          "ollama",
          { id: "llama3", provider: "ollama" },
          { reasoningEffort: "high" },
        ),
      ).rejects.toThrow(/reasoning effort "high" is not supported/);
      expect(handlers.localOrg).not.toHaveBeenCalled();
    });

    it("org local: an explicit temperature with an effort stays refused", async () => {
      await expect(
        localOrg(
          "openai",
          { id: "gpt-5.1", provider: "openai" },
          { reasoningEffort: "high", explicitTemperature: 0.7 },
        ),
      ).rejects.toThrow(/cannot both be applied/);
      expect(handlers.localOrg).not.toHaveBeenCalled();
    });
  });
});

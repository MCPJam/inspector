import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import {
  getHarnessAdapter,
  isHarnessId,
  patchClaudeCodeHarnessBootstrap,
  registeredHarnessIds,
  toAnthropicGatewayBaseUrl,
  toOpenAiCompatGatewayBaseUrl,
} from "../registry";

describe("harness registry", () => {
  it("returns the claude-code adapter", () => {
    expect(getHarnessAdapter("claude-code").id).toBe("claude-code");
  });

  it("returns the codex adapter", () => {
    const a = getHarnessAdapter("codex");
    expect(a.id).toBe("codex");
    expect(a.displayName).toBe("Codex");
    // Codex v1: no MCP servers, no skills, can't pause for tool approval.
    expect(a.supportsSelectedMcpServers).toBe(false);
    expect(a.supportsSkills).toBe(false);
    expect(a.supportsNativeToolApproval).toBe(false);
    expect(a.requiresComputer).toBe(true);
    expect(a.fileChangeToolName).toBe("fileChange");
  });

  it("maps Gateway Anthropic model ids to Claude Code selectable models", () => {
    const { toNativeModel } = getHarnessAdapter("claude-code");
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(toNativeModel?.("anthropic/claude-opus-4.7")).toBe(
      "claude-opus-4-7"
    );
    expect(toNativeModel?.("anthropic/claude-opus-4-6")).toBe(
      "claude-opus-4-6"
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-4.6")).toBe(
      "claude-sonnet-4-6"
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5"
    );
    // Dated/pinned snapshot suffix (the exact shape Claude Code's own alias
    // resolution can produce on the wire — see the bridge's modelOverrides
    // keys) must still resolve to the haiku alias, not fall through to
    // undefined (which would silently drop the model pin).
    expect(toNativeModel?.("anthropic/claude-haiku-4-5-20251001")).toBe(
      "haiku"
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5"
    );
    // Major-only dated snapshot (no minor version between major and date):
    // the optional minor group's greedy digit match must not swallow the
    // date as if it were a minor version.
    expect(toNativeModel?.("anthropic/claude-opus-4-20250929")).toBe(
      "claude-opus-4"
    );
    // A bare substring match must NOT route a non-Anthropic/malformed id to
    // Claude Code's haiku alias (the regex-gated shortcut, not a loose
    // .includes check).
    expect(toNativeModel?.("openai/my-haiku-experiment")).toBeUndefined();
    expect(toNativeModel?.("openai/gpt-5")).toBeUndefined();
  });

  it("maps Codex models via an allowlist (gpt-5 family only)", () => {
    const { toNativeModel } = getHarnessAdapter("codex");
    expect(toNativeModel?.("openai/gpt-5-nano")).toBe("gpt-5-nano");
    expect(toNativeModel?.("openai/gpt-5.5")).toBe("gpt-5.5");
    // Not a blanket strip: non-gpt-5 OpenAI ids ⇒ undefined (Codex default).
    expect(toNativeModel?.("openai/o1")).toBeUndefined();
    // Non-OpenAI ids never map.
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBeUndefined();
  });

  it("normalizes the gateway base URL per wire protocol", () => {
    // Claude Code's CLI joins `${ANTHROPIC_BASE_URL}/v1/messages` itself, so a
    // /v1-suffixed base yields …/v1/v1/messages → live-gateway 404 on every
    // model call. Its base must be the bare origin.
    expect(toAnthropicGatewayBaseUrl("https://ai-gateway.vercel.sh/v1")).toBe(
      "https://ai-gateway.vercel.sh"
    );
    expect(toAnthropicGatewayBaseUrl("https://ai-gateway.vercel.sh/v1/")).toBe(
      "https://ai-gateway.vercel.sh"
    );
    expect(toAnthropicGatewayBaseUrl("https://ai-gateway.vercel.sh")).toBe(
      "https://ai-gateway.vercel.sh"
    );
    // Codex's CLI treats OPENAI_BASE_URL as an OpenAI-compatible /v1 root.
    expect(toOpenAiCompatGatewayBaseUrl("https://ai-gateway.vercel.sh")).toBe(
      "https://ai-gateway.vercel.sh/v1"
    );
    expect(
      toOpenAiCompatGatewayBaseUrl("https://ai-gateway.vercel.sh/v1")
    ).toBe("https://ai-gateway.vercel.sh/v1");
    expect(
      toOpenAiCompatGatewayBaseUrl("https://ai-gateway.vercel.sh/v1/")
    ).toBe("https://ai-gateway.vercel.sh/v1");
  });

  it("supportsModel: Claude Code runs anything, Codex only gpt-5", () => {
    const cc = getHarnessAdapter("claude-code");
    const codex = getHarnessAdapter("codex");
    expect(cc.supportsModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(cc.supportsModel("openai/gpt-5-nano")).toBe(true);
    expect(codex.supportsModel("openai/gpt-5-nano")).toBe(true);
    // MCPJam-provided but not Codex-mappable ⇒ unsupported (rejected in preflight).
    expect(codex.supportsModel("anthropic/claude-haiku-4.5")).toBe(false);
    expect(codex.supportsModel("openai/o1")).toBe(false);
  });

  it("patches the Claude Code bridge bootstrap compatibility gaps", async () => {
    const harness = patchClaudeCodeHarnessBootstrap({
      getBootstrap: async () => ({
        harnessId: "claude-code",
        bootstrapDir: "/tmp/harness/claude-code",
        files: [
          {
            path: "/tmp/harness/claude-code/bridge.mjs",
            content: `async function drive() {
  let streamStarted = false;
  const partialBlocks = new Map();
  const permissionOptions = createPermissionOptions({
    start,
    turn,
    emit,
    nativeToolCallNames,
    approvalRequestedToolUseIds
  });
  const q = claudeSdk.query({
    options: {
      ...start.model ? { model: start.model } : {},
      ...start.maxTurns !== void 0 ? { maxTurns: start.maxTurns } : {},
    }
  });
  for await (const msg of q) {
    const type = msg.type;
    if (type === "stream_event") {
        handleStreamEvent(msg.event, partialBlocks, emit);
        continue;
      }
    if (type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
          if (block.type === "tool_use" && typeof block.id === "string") {
          emit({ type: "tool-call" });
        }
      }
    }
    if (type === "result") {
      const emptyResult = !msg.result?.trim?.();
          if (emptyResult && observedTerminalError) {
        emitTerminalError(observedTerminalError);
      }
    }
  }
}
const toUserMessage = (text) => ({
  type: "user",
    message: {
      role: "user"
    }
});`,
          },
        ],
        commands: [],
      }),
    } as any);

    const bootstrap = await harness.getBootstrap?.();
    const bridge = bootstrap?.files.find((file) =>
      file.path.endsWith("/bridge.mjs")
    );
    expect(bridge?.content).toContain("parent_tool_use_id: null");
    expect(bridge?.content).toContain("emitAssistantTextFallback");
    expect(bridge?.content).toContain("streamedAssistantText = true");
    expect(bridge?.content).toContain("emitAssistantTextFallback(block.text)");
    expect(bridge?.content).toContain("emitAssistantTextFallback(msg.result)");
    expect(bridge?.content).toContain("gatewayModelOverrideSettings");
    expect(bridge?.content).toContain("modelOverrides");
    expect(bridge?.content).toContain("anthropic/claude-");
    expect(bridge?.content).toContain("claude-haiku-4-5-20251001");
    // Fallback dedup only suppresses an EXACT repeat of the immediately prior
    // fallback (e.g. msg.result echoing the last text block) — never a full
    // history Set, which would drop legitimate non-adjacent repeats, and
    // never a "first-emission-only" flag, which would silently swallow a
    // distinct trailing msg.result (the real final answer) after any earlier
    // fallback fired.
    expect(bridge?.content).toContain("let lastEmittedFallbackText");
    expect(bridge?.content).toContain(
      "normalized === lastEmittedFallbackText"
    );
    expect(bridge?.content).not.toContain("emittedAssistantTextFallbacks");
    // Gateway compat: the CLI must omit output_config.effort (the gateway's
    // Anthropic-compat schema 400s on it).
    expect(bridge?.content).toContain(
      'process.env.CLAUDE_CODE_EFFORT_LEVEL ??= "unset"'
    );
  });

  it("patches the installed Claude Code bridge bootstrap", async () => {
    const harness = patchClaudeCodeHarnessBootstrap(
      createClaudeCode({
        model: "haiku",
        auth: {
          gateway: {
            apiKey: "test",
            baseUrl: "https://ai-gateway.vercel.sh/v1",
          },
        },
      }) as any
    );

    const bootstrap = await harness.getBootstrap?.();
    const bridge = bootstrap?.files.find((file) =>
      file.path.endsWith("/bridge.mjs")
    );
    expect(bridge?.content).toContain("parent_tool_use_id: null");
    expect(bridge?.content).toContain("emitAssistantTextFallback");
    expect(bridge?.content).toContain("gatewayModelOverrideSettings");
    expect(bridge?.content).toContain("modelOverrides");
    expect(bridge?.content).toContain("claude-haiku-4-5-20251001");
    expect(bridge?.content).toContain(
      'process.env.CLAUDE_CODE_EFFORT_LEVEL ??= "unset"'
    );
  });

  it("Claude Code attributes mcp__ tool names; Codex passes them through", () => {
    const keyToServerId = { weather: "srv_123" };
    expect(
      getHarnessAdapter("claude-code").parseToolName(
        "mcp__weather__forecast",
        keyToServerId
      )
    ).toEqual({ serverId: "srv_123", toolName: "forecast" });
    // Codex v1 has no MCP namespacing — names pass through as native tools.
    expect(
      getHarnessAdapter("codex").parseToolName(
        "mcp__weather__forecast",
        keyToServerId
      )
    ).toEqual({ toolName: "mcp__weather__forecast" });
  });

  it("isHarnessId narrows registered ids and rejects junk", () => {
    expect(isHarnessId("claude-code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("pi")).toBe(false);
    expect(isHarnessId("__proto__")).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
  });

  it("registry keys are at parity with the SDK HARNESS_IDS (no drift)", () => {
    expect([...registeredHarnessIds()].sort()).toEqual([...HARNESS_IDS].sort());
  });

  it("throws for an unknown harness id (e.g. a not-yet-installed adapter)", () => {
    // `pi` is a plausible-but-unregistered runtime (codex is now installed).
    expect(() => getHarnessAdapter("pi")).toThrow(/Unsupported harness/);
  });

  describe("deliverMcpServers (refactor guard — Claude .mcp.json unchanged)", () => {
    const mcpJson = {
      mcpServers: {
        weather: { type: "http" as const, url: "https://example.com/mcp" },
      },
    };

    it("Claude Code writes the same path + content the inline write did", async () => {
      const adapter = getHarnessAdapter("claude-code");
      const writes: { path: string; content: string }[] = [];
      await adapter.deliverMcpServers?.({
        writeTextFile: async (a) => {
          writes.push(a);
        },
        sessionWorkDir: "/home/user/work",
        mcpJson,
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]!.path).toBe("/home/user/work/.mcp.json");
      // Content is the canonical serialization (same helper as before the refactor).
      expect(JSON.parse(writes[0]!.content)).toEqual(mcpJson);
    });

    it("Codex declares no MCP delivery (v1: no servers)", () => {
      expect(getHarnessAdapter("codex").deliverMcpServers).toBeUndefined();
      expect(getHarnessAdapter("codex").supportsSelectedMcpServers).toBe(false);
    });
  });

  describe("listBuiltinTools (display catalog)", () => {
    // The set evolves with the published adapter, so assert MEMBERSHIP of known
    // tools — never a fixed count.
    const list = getHarnessAdapter("claude-code").listBuiltinTools();

    it("constructs without auth/sandbox and returns a non-empty catalog", () => {
      expect(list.length).toBeGreaterThan(0);
    });

    it("includes the known core + native-only tools (keyed by record key)", () => {
      const keys = new Set(list.map((t) => t.key));
      for (const expected of [
        "read",
        "write",
        "edit",
        "bash",
        "glob",
        "grep",
        "webSearch",
        "WebFetch",
        "NotebookEdit",
      ]) {
        expect(keys).toContain(expected);
      }
    });

    it("normalizes every entry: non-empty name, JSON-Schema where present, sorted", () => {
      for (const t of list) {
        expect(typeof t.name).toBe("string");
        expect(t.name.length).toBeGreaterThan(0);
        if (t.inputSchema !== undefined) {
          expect(typeof t.inputSchema).toBe("object");
        }
      }
      const names = list.map((t) => t.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("at least one tool exposes a usable input schema (bash/read take params)", () => {
      const withSchema = list.filter((t) => t.inputSchema !== undefined);
      expect(withSchema.length).toBeGreaterThan(0);
    });
  });
});

/**
 * The hoisted agent Chat instance store: identity, config freshness, LRU
 * pinning, and the home → side-panel handoff fired by navigation-capable
 * WebMCP UI tools.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  chatInstances: [] as any[],
  lastTransportOptions: null as any,
}));

vi.mock("@ai-sdk/react", () => ({
  Chat: class MockChat {
    id: string;
    messages: unknown[] = [];
    status = "ready";
    init: any;
    addToolOutput = vi.fn();
    addToolApprovalResponse = vi.fn();
    constructor(init: { id: string }) {
      this.init = init;
      this.id = init.id;
      mockState.chatInstances.push(this);
    }
  },
}));

const aiPredicateMocks = vi.hoisted(() => ({
  toolCallsComplete: vi.fn(),
  approvalsComplete: vi.fn(),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: unknown) {
      mockState.lastTransportOptions = options;
    }
  },
  lastAssistantMessageIsCompleteWithToolCalls:
    aiPredicateMocks.toolCallsComplete,
  lastAssistantMessageIsCompleteWithApprovalResponses:
    aiPredicateMocks.approvalsComplete,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

import posthog from "posthog-js";
import {
  __resetAgentChatInstancesForTests,
  getOrCreateAgentChat,
} from "../agent-chat-instances";
import { __resetUiToolExecutorForTests } from "@/lib/webmcp/ui-tool-executor";
import {
  AGENT_PANEL_STORAGE_KEY,
  useAgentPanelStore,
} from "@/stores/agent-panel/agent-panel-store";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "@/lib/webmcp/ui-tools-registry";

function registerTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  const def: UiToolDefinition = {
    name: "ui_navigate",
    description: "Navigate the MCPJam inspector",
    readOnly: false,
    mayNavigate: true,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    })),
    ...extra,
  };
  useUiToolsRegistry.getState().registerUiTool(def);
  return def;
}

describe("agent-chat-instances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.chatInstances = [];
    mockState.lastTransportOptions = null;
    __resetAgentChatInstancesForTests();
    __resetUiToolExecutorForTests();
    window.localStorage.removeItem(AGENT_PANEL_STORAGE_KEY);
    useAgentPanelStore.setState({
      isOpen: false,
      activeSessionId: null,
      activeSessionProjectId: null,
    });
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  it("returns the same entry per session id", () => {
    const a = getOrCreateAgentChat("s1");
    const b = getOrCreateAgentChat("s1");
    const c = getOrCreateAgentChat("s2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(mockState.chatInstances).toHaveLength(2);
  });

  it("transport body reads the mutable config at POST time", () => {
    const { config } = getOrCreateAgentChat("s1");
    config.projectId = "p1";
    config.model = { id: "m1", provider: "anthropic", name: "M1" } as any;
    const body = mockState.lastTransportOptions.body();
    expect(body).toMatchObject({
      chatSessionId: "s1",
      projectId: "p1",
      model: expect.objectContaining({ id: "m1" }),
    });
    config.projectId = "p2";
    expect(mockState.lastTransportOptions.body().projectId).toBe("p2");
  });

  it("evicts only idle, detached instances beyond the cap", () => {
    const pinnedStreaming = getOrCreateAgentChat("streaming");
    (pinnedStreaming.chat as any).status = "streaming";
    const pinnedAttached = getOrCreateAgentChat("attached");
    pinnedAttached.config.attachedSurfaces.add("side-panel");
    const originalIdle1 = getOrCreateAgentChat("idle-1").chat;
    getOrCreateAgentChat("idle-2");
    getOrCreateAgentChat("idle-3");
    // 6th insertion pushes size past the cap of 4 → oldest idle+detached go.
    getOrCreateAgentChat("idle-4");

    expect(getOrCreateAgentChat("streaming")).toBe(pinnedStreaming);
    expect(getOrCreateAgentChat("attached")).toBe(pinnedAttached);
    // idle-1 was the oldest evictable entry; a fresh call re-creates it.
    expect(getOrCreateAgentChat("idle-1").chat).not.toBe(originalIdle1);
  });

  it("never evicts the just-created instance, even when all others are pinned", () => {
    // Surfaces attach in a React effect AFTER creation, so a brand-new
    // entry looks idle+detached during the eviction sweep its own insert
    // triggers. Evicting it would split-brain the session: the hook keeps
    // the evicted instance while the next getOrCreateAgentChat mints a
    // second one.
    for (const id of ["p1", "p2", "p3", "p4"]) {
      const pinned = getOrCreateAgentChat(id);
      (pinned.chat as any).status = "streaming";
    }
    const fresh = getOrCreateAgentChat("fresh");
    expect(getOrCreateAgentChat("fresh")).toBe(fresh);
  });

  describe("tool approval", () => {
    it("body carries the config's requireToolApproval at POST time", () => {
      const { config } = getOrCreateAgentChat("s1");
      expect(mockState.lastTransportOptions.body().requireToolApproval).toBe(
        false
      );
      config.requireToolApproval = true;
      expect(mockState.lastTransportOptions.body().requireToolApproval).toBe(
        true
      );
    });

    it("defers mutating ui_* calls when approval is on (pill resolves them)", async () => {
      const def = registerTool();
      const entry = getOrCreateAgentChat("s1");
      entry.config.requireToolApproval = true;

      await entry.chat.init.onToolCall({
        toolCall: {
          toolName: "ui_navigate",
          toolCallId: "tc-defer",
          input: { target: "servers" },
        },
      });

      expect(def.execute).not.toHaveBeenCalled();
      expect((entry.chat as any).addToolOutput).not.toHaveBeenCalled();
      // Deferral must also not hand off — nothing navigated yet.
      expect(useAgentPanelStore.getState().isOpen).toBe(false);
    });

    it("handleToolApprovalResponse: approve executes + ships result; deny sends the response", async () => {
      const def = registerTool();
      const entry = getOrCreateAgentChat("s1");
      entry.config.requireToolApproval = true;
      // Two distinct gated calls: denying one must not affect the other
      // (and a denied call is settled — see the executor's
      // settleDeniedUiToolCall — so approve/deny must target separate ids).
      (entry.chat as any).messages = [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "ui_navigate",
              toolCallId: "tc-deny",
              state: "approval-requested",
              input: { target: "evals" },
              approval: { id: "appr-deny" },
            },
            {
              type: "dynamic-tool",
              toolName: "ui_navigate",
              toolCallId: "tc-appr",
              state: "approval-requested",
              input: { target: "servers" },
              approval: { id: "appr-appr" },
            },
          ],
        },
      ];

      entry.handleToolApprovalResponse({ id: "appr-deny", approved: false });
      expect(
        (entry.chat as any).addToolApprovalResponse
      ).toHaveBeenCalledWith({ id: "appr-deny", approved: false });
      expect(def.execute).not.toHaveBeenCalled();

      entry.handleToolApprovalResponse({ id: "appr-appr", approved: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(def.execute).toHaveBeenCalledWith({ target: "servers" });
      expect((entry.chat as any).addToolOutput).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "tc-appr" })
      );
    });

    it("sendAutomaticallyWhen resumes on answered approvals regardless of the current flag", () => {
      // A pill minted while the toggle was ON must still resume the turn if
      // the user flips it off before answering — the predicate is inert when
      // the message holds no approval requests, so no flag gate is needed.
      const entry = getOrCreateAgentChat("s1");
      const predicate = entry.chat.init.sendAutomaticallyWhen;

      aiPredicateMocks.toolCallsComplete.mockReturnValue(false);
      aiPredicateMocks.approvalsComplete.mockReturnValue(true);
      expect(entry.config.requireToolApproval).toBe(false);
      expect(predicate({ messages: [] })).toBe(true);

      aiPredicateMocks.approvalsComplete.mockReturnValue(false);
      expect(predicate({ messages: [] })).toBe(false);
    });
  });

  describe("home → side-panel handoff", () => {
    async function fireNavigate(entry: ReturnType<typeof getOrCreateAgentChat>) {
      await entry.chat.init.onToolCall({
        toolCall: {
          toolName: "ui_navigate",
          toolCallId: "tc-1",
          input: { target: "servers" },
        },
      });
    }

    it("adopts the session into the panel BEFORE the tool executes", async () => {
      let panelStateAtExecute: {
        isOpen: boolean;
        activeSessionId: string | null;
      } | null = null;
      registerTool({
        execute: vi.fn(async () => {
          const s = useAgentPanelStore.getState();
          panelStateAtExecute = {
            isOpen: s.isOpen,
            activeSessionId: s.activeSessionId,
          };
          return { content: [{ type: "text" as const, text: "ok" }] };
        }),
      });
      const entry = getOrCreateAgentChat("s-home");
      entry.config.projectId = "p1";
      entry.config.attachedSurfaces.add("home");

      await fireNavigate(entry);

      expect(panelStateAtExecute).toEqual({
        isOpen: true,
        activeSessionId: "s-home",
      });
      expect(useAgentPanelStore.getState().activeSessionProjectId).toBe("p1");
      expect((entry.chat as any).addToolOutput).toHaveBeenCalled();
      expect(posthog.capture).toHaveBeenCalledWith(
        "mcpjam_agent_panel_handoff",
        expect.objectContaining({ session_id: "s-home" })
      );
    });

    it("does not hand off from the side panel", async () => {
      registerTool();
      const entry = getOrCreateAgentChat("s-panel");
      entry.config.projectId = "p1";
      entry.config.attachedSurfaces.add("side-panel");

      await fireNavigate(entry);

      expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
      expect((entry.chat as any).addToolOutput).toHaveBeenCalled();
    });

    it("does not hand off for non-navigation tools", async () => {
      registerTool({
        name: "ui_snapshot_app",
        readOnly: true,
        mayNavigate: false,
      });
      const entry = getOrCreateAgentChat("s-home");
      entry.config.projectId = "p1";
      entry.config.attachedSurfaces.add("home");

      await entry.chat.init.onToolCall({
        toolCall: { toolName: "ui_snapshot_app", toolCallId: "tc-2", input: {} },
      });

      expect(useAgentPanelStore.getState().activeSessionId).toBeNull();
      expect((entry.chat as any).addToolOutput).toHaveBeenCalled();
    });

    it("skips (with telemetry) when projectId is missing, and still executes", async () => {
      const def = registerTool();
      const entry = getOrCreateAgentChat("s-home");
      entry.config.attachedSurfaces.add("home");

      await fireNavigate(entry);

      expect(useAgentPanelStore.getState().isOpen).toBe(false);
      expect(posthog.capture).toHaveBeenCalledWith(
        "mcpjam_agent_panel_handoff_skipped",
        expect.objectContaining({ reason: "no_project_id" })
      );
      expect(def.execute).toHaveBeenCalled();
      expect((entry.chat as any).addToolOutput).toHaveBeenCalled();
    });
  });
});

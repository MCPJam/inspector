/**
 * Module-level store of live MCPJam Agent `Chat` instances, keyed by
 * chatSessionId.
 *
 * Why this exists: the agent renders on route-bound surfaces (the Home
 * takeover) as well as the always-mounted side panel. A `useChat` instance
 * owned by a route-bound component dies with it on navigation — which a
 * WebMCP UI tool like `ui_navigate` can trigger mid-turn, killing the
 * in-flight stream before its tool output and auto-resume are delivered
 * (and the server only persists turns that complete un-aborted). Hoisting
 * the `Chat` instance here means any surface can attach/detach via
 * `useChat({ chat })` without owning the stream's lifetime.
 *
 * The per-instance `config` object is the mutable bridge between React and
 * the instance's closures: the transport `body()` and callbacks read it at
 * call time, and `useMcpjamAgentSession` keeps it in sync each render.
 */
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import posthog from "posthog-js";
import { authFetch } from "@/lib/session-token";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";
import { handleUiToolCall } from "@/lib/webmcp/ui-tool-executor";
import { createUiAwareApprovalResponseHandler } from "@/lib/webmcp/ui-tool-approval";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import type { ModelDefinition } from "@/shared/types";

const AGENT_API_PATH = "/api/web/mcpjam-agent";

/**
 * Surfaces that die on navigation. The side panel is mounted outside the
 * router outlet and survives; the Home takeover ("home") is keyed off the
 * `/home?session=` route and unmounts when a UI tool changes the route.
 */
const ROUTE_BOUND_SURFACES = new Set(["home"]);

/**
 * Cap on retained instances. Eviction skips instances that are streaming or
 * have a surface attached, so a long-running background turn always finishes
 * (and therefore persists server-side) even if the user opens several other
 * sessions meanwhile.
 */
const MAX_INSTANCES = 4;

export interface AgentChatConfig {
  chatSessionId: string;
  /** Kept current by the hook; `body()` reads it at POST time. */
  projectId: string | null;
  /** Kept current by the hook; `body()` reads it at POST time. */
  model: ModelDefinition | undefined;
  /**
   * Surfaces currently rendering this session ("home", "side-panel", …).
   * Effect-managed (symmetric add/remove) so the brief double-attach window
   * during a handoff is represented accurately, unlike a last-write-wins
   * field.
   */
  attachedSurfaces: Set<string>;
  /**
   * True once the persisted transcript has been seeded into the instance
   * (or the session was minted fresh by a first submit). Lives here — not in
   * a per-hook ref — so a second surface adopting a live instance can never
   * re-seed stale history over an in-flight turn.
   */
  seeded: boolean;
  /**
   * The agent surface's "Tool Approval" preference, synced by the hook from
   * `agent-tool-approval-storage`. Read at call time by `body()`, the
   * executor's defer gate, and the auto-send predicate.
   */
  requireToolApproval: boolean;
}

export interface AgentChatEntry {
  chat: Chat<UIMessage>;
  config: AgentChatConfig;
  /**
   * UI-tool-aware approval responses for this instance: Approve on a `ui_*`
   * part executes in the browser and ships the result; Deny and non-UI
   * tools send the plain approval response. Pass as the thread's
   * `onToolApprovalResponse`.
   */
  handleToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}

const instances = new Map<string, AgentChatEntry>();

/**
 * When a navigation-capable UI tool fires while the session is rendered on a
 * route-bound surface, adopt the session into the always-mounted side panel
 * BEFORE the route commits. The panel's thread (keyed by session id) attaches
 * to this same live Chat instance, so the conversation — including the
 * in-flight turn — stays visible and continues streaming there.
 *
 * Runs synchronously (store writes only) from the executor's pre-execute
 * hook; the hoisted instance makes the ordering soft — even if the panel
 * mounts a frame after the route change, nothing is lost.
 */
function maybeHandoffToPanel(config: AgentChatConfig, toolName: string): void {
  const onRouteBoundSurface = [...config.attachedSurfaces].some((s) =>
    ROUTE_BOUND_SURFACES.has(s)
  );
  if (!onRouteBoundSurface) return;
  const panel = useAgentPanelStore.getState();
  if (panel.activeSessionId === config.chatSessionId && panel.isOpen) return;
  if (!config.projectId) {
    // The panel's project-mismatch GC (AgentSidePanelMount) would clear a
    // null-project pointer immediately — skip rather than flicker.
    posthog.capture("mcpjam_agent_panel_handoff_skipped", {
      session_id: config.chatSessionId,
      tool_name: toolName,
      reason: "no_project_id",
    });
    return;
  }
  panel.setActiveSession(config.chatSessionId, config.projectId);
  panel.setOpen(true);
  posthog.capture("mcpjam_agent_panel_handoff", {
    from_surface: "home",
    session_id: config.chatSessionId,
    tool_name: toolName,
  });
}

function evictIdleInstances(): void {
  if (instances.size <= MAX_INSTANCES) return;
  for (const [key, entry] of instances) {
    if (instances.size <= MAX_INSTANCES) return;
    const status = entry.chat.status;
    const idle = status === "ready" || status === "error";
    if (idle && entry.config.attachedSurfaces.size === 0) {
      instances.delete(key);
    }
  }
}

export function getOrCreateAgentChat(chatSessionId: string): AgentChatEntry {
  const existing = instances.get(chatSessionId);
  if (existing) {
    // LRU touch: re-insert so iteration order reflects recency.
    instances.delete(chatSessionId);
    instances.set(chatSessionId, existing);
    return existing;
  }

  const config: AgentChatConfig = {
    chatSessionId,
    projectId: null,
    model: undefined,
    attachedSurfaces: new Set(),
    seeded: false,
    requireToolApproval: false,
  };

  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id: chatSessionId,
    transport: new DefaultChatTransport({
      api: AGENT_API_PATH,
      fetch: authFetch,
      body: () => ({
        model: config.model,
        projectId: config.projectId,
        chatSessionId,
        requireToolApproval: config.requireToolApproval,
        // WebMCP UI tools snapshot, drained fresh at POST time (same
        // contract as `useChatSession`). The server validates again in
        // `validateUiToolEntries`.
        uiTools: useUiToolsRegistry.getState().snapshotForChatBody(),
      }),
    }),
    // WebMCP UI tools are no-execute server-side; the stream pauses until
    // the client supplies the result via `addToolOutput`. Non-UI names fall
    // through untouched (this surface has no app tools). `addToolOutput`
    // targets the instance directly, so fulfillment survives the
    // originating surface unmounting mid-execute.
    onToolCall: async ({ toolCall }) => {
      await handleUiToolCall({
        toolName: (toolCall as { toolName: string }).toolName,
        toolCallId: (toolCall as { toolCallId: string }).toolCallId,
        input: (toolCall as { input: unknown }).input,
        addToolOutput: (output) => {
          chat.addToolOutput(output);
        },
        onNavigationToolCall: (toolName) => {
          maybeHandoffToPanel(config, toolName);
        },
        requireToolApproval: config.requireToolApproval,
      });
    },
    // Resume the turn automatically once every tool call has an output —
    // without this, `addToolOutput` would sit unsent until the next user
    // message. With approval on, also resume once every approval request
    // has an answer (the MCP/skill-tool deny/approve path).
    sendAutomaticallyWhen: (options) => {
      if (lastAssistantMessageIsCompleteWithToolCalls(options)) return true;
      return (
        config.requireToolApproval &&
        lastAssistantMessageIsCompleteWithApprovalResponses(options)
      );
    },
  });

  const handleToolApprovalResponse = createUiAwareApprovalResponseHandler({
    getMessages: () => chat.messages,
    addToolApprovalResponse: (response) => {
      chat.addToolApprovalResponse(response);
    },
    addToolOutput: (output) => {
      chat.addToolOutput(output);
    },
    onNavigationToolCall: (toolName) => {
      maybeHandoffToPanel(config, toolName);
    },
  });

  const entry: AgentChatEntry = { chat, config, handleToolApprovalResponse };
  instances.set(chatSessionId, entry);
  evictIdleInstances();
  return entry;
}

export function __resetAgentChatInstancesForTests(): void {
  instances.clear();
}

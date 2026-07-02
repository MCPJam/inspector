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
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { authFetch } from "@/lib/session-token";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";
import { handleUiToolCall } from "@/lib/webmcp/ui-tool-executor";
import type { ModelDefinition } from "@/shared/types";

const AGENT_API_PATH = "/api/web/mcpjam-agent";

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
}

export interface AgentChatEntry {
  chat: Chat<UIMessage>;
  config: AgentChatConfig;
}

const instances = new Map<string, AgentChatEntry>();

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
      });
    },
    // Resume the turn automatically once every tool call has an output —
    // without this, `addToolOutput` would sit unsent until the next user
    // message.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const entry: AgentChatEntry = { chat, config };
  instances.set(chatSessionId, entry);
  evictIdleInstances();
  return entry;
}

export function __resetAgentChatInstancesForTests(): void {
  instances.clear();
}

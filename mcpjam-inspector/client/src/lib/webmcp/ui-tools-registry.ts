/**
 * WebMCP-shaped MCPJam UI tools registry.
 *
 * Holds the tools that let chat agents drive the MCPJam inspector UI
 * (navigate, select servers, run tools in the playground, …). The registry —
 * not the browser's native `modelContext` — is the enumerable source of truth
 * for MCPJam's own chat pipeline; each registration is additionally mirrored
 * into the native WebMCP API (best-effort, see `native-mirror.ts`) so
 * browser-native agents can call the same tools.
 *
 * The registry serves two callers, mirroring `app-tools-registry.ts`:
 *   - `snapshotForChatBody()` — drained at chat POST time so the server can
 *     register no-execute AI SDK tools that the model can pick.
 *   - `resolve(name)` — looked up by `useChat.onToolCall` (via
 *     `ui-tool-executor.ts`) to execute the tool in-page.
 *
 * Dispatch is gated on registry membership plus the per-session shipped-name
 * set — never on the `ui_` prefix alone — so a genuine MCP server tool that
 * happens to be named `ui_something` is never intercepted.
 */

import { create } from "zustand";
import { isUiToolName } from "@/shared/client-fulfilled-tools.js";
import type { UiToolSnapshotEntry } from "@/shared/chat-v2.js";
import { mirrorUiToolToNative } from "./native-mirror";

export interface UiToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface UiToolDefinition {
  /** Model-facing tool name. Must match `UI_TOOL_NAME_REGEX` (`ui_*`). */
  name: string;
  description: string;
  /** Plain JSON Schema object (no zod), same as the app-tool pipeline. */
  inputSchema?: Record<string, unknown>;
  /** Mirrored to native `annotations.readOnlyHint`; metadata, not a gate. */
  readOnly: boolean;
  execute: (args: Record<string, unknown>) => Promise<UiToolResult>;
}

// Server-mirrored limits for the chat POST snapshot (same as app tools).
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 8 * 1024;
/**
 * Cap on remembered chat sessions in `shippedNamesBySession`. Sessions are
 * dropped FIFO; 16 comfortably covers every concurrent surface (chat tab,
 * agent panel, multi-model cards) without growing unbounded.
 */
const MAX_SHIPPED_SESSIONS = 16;
/** Map key for snapshots taken without a chat session id. */
const NO_SESSION_KEY = "";

interface UiToolsRegistryState {
  tools: Map<string, UiToolDefinition>;
  /** Disposers for native `modelContext` mirrors, keyed by tool name. */
  nativeDisposers: Map<string, () => void>;
  /**
   * Names shipped to the server per chat session, unioned at snapshot time
   * and never replaced: an earlier POST's stream can still be in flight when
   * the next snapshot is taken, and its tool calls must keep resolving as
   * "ours" (even if only to an error result) so the stream never hangs.
   */
  shippedNamesBySession: Map<string, Set<string>>;

  registerUiTool: (
    def: UiToolDefinition,
    opts?: { signal?: AbortSignal },
  ) => () => void;
  unregisterUiTool: (name: string) => void;
  resolve: (name: string) => UiToolDefinition | null;
  snapshotForChatBody: (chatSessionId?: string) => UiToolSnapshotEntry[];
  wasShipped: (name: string, chatSessionId?: string) => boolean;
}

function sessionKey(chatSessionId?: string): string {
  return chatSessionId ?? NO_SESSION_KEY;
}

export const useUiToolsRegistry = create<UiToolsRegistryState>((set, get) => ({
  tools: new Map(),
  nativeDisposers: new Map(),
  shippedNamesBySession: new Map(),

  registerUiTool: (def, opts) => {
    if (!isUiToolName(def.name)) {
      // First-party catalog bug, not user input — fail loudly.
      throw new Error(
        `[webmcp] UI tool name "${def.name}" must match ui_[a-z0-9][a-z0-9_]* (max 64 chars).`,
      );
    }
    if (opts?.signal?.aborted) {
      return () => {};
    }
    if (get().tools.has(def.name)) {
      // HMR / StrictMode double-mounts re-register the same catalog; replace
      // (dropping the stale native mirror) instead of throwing.
      console.warn(`[webmcp] UI tool "${def.name}" re-registered; replacing.`);
      get().nativeDisposers.get(def.name)?.();
    }
    const dispose = mirrorUiToolToNative(def);
    set((s) => {
      const tools = new Map(s.tools);
      tools.set(def.name, def);
      const nativeDisposers = new Map(s.nativeDisposers);
      if (dispose) nativeDisposers.set(def.name, dispose);
      else nativeDisposers.delete(def.name);
      return { tools, nativeDisposers };
    });
    const unregister = () => get().unregisterUiTool(def.name);
    opts?.signal?.addEventListener("abort", unregister, { once: true });
    return unregister;
  },

  unregisterUiTool: (name) => {
    const { tools, nativeDisposers } = get();
    if (!tools.has(name)) return;
    try {
      nativeDisposers.get(name)?.();
    } catch {
      // Native mirror teardown is best-effort.
    }
    set((s) => {
      const nextTools = new Map(s.tools);
      nextTools.delete(name);
      const nextDisposers = new Map(s.nativeDisposers);
      nextDisposers.delete(name);
      return { tools: nextTools, nativeDisposers: nextDisposers };
    });
  },

  resolve: (name) => get().tools.get(name) ?? null,

  snapshotForChatBody: (chatSessionId) => {
    const out: UiToolSnapshotEntry[] = [];
    let dropped = 0;
    for (const def of get().tools.values()) {
      if (out.length >= MAX_SNAPSHOT_ENTRIES) {
        dropped += 1;
        continue;
      }
      let inputSchema = def.inputSchema;
      if (inputSchema) {
        let size = 0;
        try {
          size = new TextEncoder().encode(JSON.stringify(inputSchema)).length;
        } catch {
          continue; // unserializable — first-party bug, skip defensively
        }
        if (size > MAX_INPUT_SCHEMA_BYTES) continue;
      }
      out.push({
        name: def.name,
        description: def.description.slice(0, MAX_DESCRIPTION_CHARS),
        inputSchema,
        readOnly: def.readOnly,
      });
    }
    if (dropped > 0) {
      console.warn(
        `[webmcp] UI tools snapshot capped at ${MAX_SNAPSHOT_ENTRIES} entries; dropped ${dropped}.`,
      );
    }
    if (out.length > 0) {
      set((s) => {
        const key = sessionKey(chatSessionId);
        const shippedNamesBySession = new Map(s.shippedNamesBySession);
        const shipped = new Set(shippedNamesBySession.get(key));
        for (const entry of out) shipped.add(entry.name);
        // Re-insert so the key moves to the back of the FIFO order.
        shippedNamesBySession.delete(key);
        shippedNamesBySession.set(key, shipped);
        while (shippedNamesBySession.size > MAX_SHIPPED_SESSIONS) {
          const oldest = shippedNamesBySession.keys().next().value;
          if (oldest === undefined) break;
          shippedNamesBySession.delete(oldest);
        }
        return { shippedNamesBySession };
      });
    }
    return out;
  },

  wasShipped: (name, chatSessionId) =>
    get().shippedNamesBySession.get(sessionKey(chatSessionId))?.has(name) ===
    true,
}));

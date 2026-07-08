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
 * Dispatch is gated on registry membership (`resolve`) — never on the `ui_`
 * prefix alone — so a genuine MCP server tool that happens to be named
 * `ui_something` is never intercepted. The page-global `shippedNames` set is
 * NOT a dispatch gate: it only decides whether an unresolvable (e.g.
 * unregistered-while-in-flight) call gets an error output instead of hanging
 * the paused stream.
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
  /**
   * Executing this tool can change the SPA route (directly, or via the
   * auto-open-playground fallback). Route-bound chat surfaces use this to
   * hand the conversation off to the always-mounted side panel BEFORE the
   * route commits. Client-only metadata — `snapshotForChatBody` never ships
   * it to the server.
   */
  mayNavigate?: boolean;
  execute: (args: Record<string, unknown>) => Promise<UiToolResult>;
}

// Server-mirrored limits for the chat POST snapshot (same as app tools).
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 8 * 1024;

interface UiToolsRegistryState {
  tools: Map<string, UiToolDefinition>;
  /** Disposers for native `modelContext` mirrors, keyed by tool name. */
  nativeDisposers: Map<string, () => void>;
  /**
   * Every name ever shipped to the server in a snapshot, unioned at snapshot
   * time and NEVER evicted: a `ui_*` tool call only reaches `onToolCall`
   * when that stream's own snapshot advertised the name, and an in-flight
   * stream can outlive both the tool's registration and any session-scoped
   * bookkeeping. The set is bounded by the names this page ever registers
   * (first-party catalog), so page-lifetime retention is safe — and it is
   * what guarantees an unresolvable call still gets an error output instead
   * of hanging the paused stream.
   */
  shippedNames: Set<string>;

  registerUiTool: (
    def: UiToolDefinition,
    opts?: { signal?: AbortSignal },
  ) => () => void;
  unregisterUiTool: (name: string) => void;
  resolve: (name: string) => UiToolDefinition | null;
  snapshotForChatBody: () => UiToolSnapshotEntry[];
  wasShipped: (name: string) => boolean;
}

export const useUiToolsRegistry = create<UiToolsRegistryState>((set, get) => ({
  tools: new Map(),
  nativeDisposers: new Map(),
  shippedNames: new Set(),

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

  snapshotForChatBody: () => {
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
        const shippedNames = new Set(s.shippedNames);
        for (const entry of out) shippedNames.add(entry.name);
        return { shippedNames };
      });
    }
    return out;
  },

  wasShipped: (name) => get().shippedNames.has(name),
}));

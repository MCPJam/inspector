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
import type { UiToolAnnotations } from "@/shared/client-fulfilled-tools.js";
import type { UiToolSnapshotEntry } from "@/shared/mcpjam-ui-tools.js";
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
  /**
   * Legacy read-only flag. Kept as the wire-compatible mirror of
   * `annotations.readOnlyHint`; `registerUiTool` rejects a definition where
   * the two disagree. Prefer reading `annotations`.
   */
  readOnly: boolean;
  /**
   * MCP `ToolAnnotations` for this tool. Drives approval policy
   * (`uiToolCallNeedsApproval`) and is projected onto the native WebMCP
   * descriptor. Every entry in the first-party catalog sets these
   * explicitly — an absent `destructiveHint` is read as DESTRUCTIVE (the
   * protocol's pessimistic default), so a tool added without annotations
   * gates rather than executing silently.
   */
  annotations?: UiToolAnnotations;
  /**
   * WebMCP's `untrustedContentHint` for the NATIVE mirror only. WebMCP has
   * its own signal for "this tool's output is externally sourced and should
   * be treated as untrusted"; MCP's `openWorldHint` is a different thing, so
   * a native agent won't infer it. Set true for a tool whose result comes
   * from a third party (e.g. `ui_execute_tool` runs an arbitrary MCP server).
   * Client-only: it is NOT a valid MCP annotation, so the server validator
   * would reject it — `snapshotForChatBody` never ships it.
   */
  nativeUntrustedContentHint?: boolean;
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
   * Names registered with `scope: "global"` (the app-wide catalog). Kept as
   * a parallel set — not on the map values — so `resolve()` and the executor
   * keep seeing plain `UiToolDefinition`s. Drives snapshot ordering only.
   */
  globalNames: Set<string>;
  /**
   * Current owner token per registered name. A registration's unregister
   * closure only tears down while its own token is still the live one, so a
   * `UiToolDefinition` object shared by two registrars can't be mis-owned.
   */
  ownerTokens: Map<string, symbol>;
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
    opts?: {
      signal?: AbortSignal;
      /**
       * `"global"` = app-wide catalog, `"surface"` (default) = mounted while
       * a specific surface is. `snapshotForChatBody` emits globals first so
       * the 64-entry cap can never evict the global catalog in favor of
       * whichever surface's effect happened to register earlier.
       */
      scope?: "global" | "surface";
    },
  ) => () => void;
  /**
   * Unconditional by-name removal, for callers that explicitly own a name.
   * The closure returned by `registerUiTool` is NOT this: it is ownership-
   * guarded, a no-op once another registration has replaced the name.
   */
  unregisterUiTool: (name: string) => void;
  resolve: (name: string) => UiToolDefinition | null;
  snapshotForChatBody: () => UiToolSnapshotEntry[];
  wasShipped: (name: string) => boolean;
}

export const useUiToolsRegistry = create<UiToolsRegistryState>((set, get) => ({
  tools: new Map(),
  nativeDisposers: new Map(),
  globalNames: new Set(),
  ownerTokens: new Map(),
  shippedNames: new Set(),

  registerUiTool: (def, opts) => {
    if (!isUiToolName(def.name)) {
      // First-party catalog bug, not user input — fail loudly.
      throw new Error(
        `[webmcp] UI tool name "${def.name}" must match ui_[a-z0-9][a-z0-9_]* (max 64 chars).`,
      );
    }
    if (
      def.annotations?.readOnlyHint !== undefined &&
      def.annotations.readOnlyHint !== def.readOnly
    ) {
      // The server validator rejects contradictory snapshots; catching it at
      // registration turns a 400 on every chat POST into an obvious local
      // failure. Same posture as the name check: first-party bug, fail loud.
      throw new Error(
        `[webmcp] UI tool "${def.name}" has readOnly=${def.readOnly} but annotations.readOnlyHint=${def.annotations.readOnlyHint}; they must agree.`,
      );
    }
    if (opts?.signal?.aborted) {
      return () => {};
    }
    const existing = get().tools.get(def.name);
    if (existing) {
      // A LIVE same-name registration means two registrars claim one name:
      // legitimate re-registration (HMR / StrictMode remounts) runs cleanup
      // before setup, so no collision exists by the time setup re-registers.
      // Escalate in the dev server (MODE, not DEV — vitest sets DEV=true and
      // the warn+replace contract must stay testable); in prod, replace with
      // a warn so a missed cleanup degrades instead of blanking the tool.
      if (import.meta.env.MODE === "development") {
        throw new Error(
          `[webmcp] UI tool "${def.name}" registered while an earlier ` +
            `registration is still live (existing: "${existing.description.slice(0, 80)}"; ` +
            `incoming: "${def.description.slice(0, 80)}"). ` +
            `Unregister the previous owner first.`,
        );
      }
      console.warn(`[webmcp] UI tool "${def.name}" re-registered; replacing.`);
      get().nativeDisposers.get(def.name)?.();
    }
    const dispose = mirrorUiToolToNative(def);
    // Per-registration ownership token. NOT `def` identity: two registrars can
    // share the same module-level `UiToolDefinition` object, so a def-identity
    // guard would let a replaced registration's stale unregister still match
    // (and delete) the replacement. Each register() call mints a fresh token;
    // cleanup only fires while its own token is the live one for the name.
    const ownerToken = Symbol(def.name);
    set((s) => {
      const tools = new Map(s.tools);
      tools.set(def.name, def);
      const nativeDisposers = new Map(s.nativeDisposers);
      if (dispose) nativeDisposers.set(def.name, dispose);
      else nativeDisposers.delete(def.name);
      const globalNames = new Set(s.globalNames);
      if (opts?.scope === "global") globalNames.add(def.name);
      else globalNames.delete(def.name);
      const ownerTokens = new Map(s.ownerTokens);
      ownerTokens.set(def.name, ownerToken);
      return { tools, nativeDisposers, globalNames, ownerTokens };
    });
    const unregister = () => {
      // Ownership guard: tear down only while OUR registration is still the
      // live one (checked by token, so a shared def object can't confuse it).
      // After a warn+replace, the replaced registration's unregister/abort
      // must not delete the replacement or dispose its native mirror.
      if (get().ownerTokens.get(def.name) !== ownerToken) return;
      get().unregisterUiTool(def.name);
    };
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
      const nextGlobals = new Set(s.globalNames);
      nextGlobals.delete(name);
      const nextOwnerTokens = new Map(s.ownerTokens);
      nextOwnerTokens.delete(name);
      return {
        tools: nextTools,
        nativeDisposers: nextDisposers,
        globalNames: nextGlobals,
        ownerTokens: nextOwnerTokens,
      };
    });
  },

  resolve: (name) => get().tools.get(name) ?? null,

  snapshotForChatBody: () => {
    const out: UiToolSnapshotEntry[] = [];
    let dropped = 0;
    // Globals first, then surface tools, each in insertion order: the
    // 64-entry cap drops from the tail, and a surface's useLayoutEffect can
    // register before App's useEffect — pure insertion order could evict the
    // app-wide catalog on overflow.
    const { tools, globalNames } = get();
    const defs = [...tools.values()];
    const ordered = [
      ...defs.filter((d) => globalNames.has(d.name)),
      ...defs.filter((d) => !globalNames.has(d.name)),
    ];
    for (const def of ordered) {
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
        ...(def.annotations ? { annotations: def.annotations } : {}),
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

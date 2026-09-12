/**
 * MCPJam `ui_*` tools registry — the browser-side tool set for MCPJam's own
 * inspector actions.
 *
 * Holds the tools that are resolved IN THE PAGE rather than on the server.
 * Two kinds, and the name covers both:
 *   - driving the inspector UI — navigate, select servers, run a tool in the
 *     playground — where the user watches the action happen, and
 *   - collecting input from it — `ui_ask_user` paints a question card and
 *     parks the turn until the user answers.
 *
 * TWO ACCESS PATHS, ONE CATALOG. The registry is the single source of truth
 * for both agents that can reach these tools:
 *   - the in-app "Ask MCPJam" agent, over MCPJam's own transport
 *     (`snapshotForChatBody()` at chat POST time, `resolve()` from the chat
 *     executor), and
 *   - a browser-native WebMCP agent, over `document.modelContext`
 *     (`native-tool-publisher.ts` subscribes here and mirrors the eligible
 *     tools out; both paths execute through `ui-tool-execution.ts`).
 *
 * Eligibility is per definition and explicit: `nativePublication`. Tools that
 * need an MCPJam conversation to mean anything (`ui_ask_user`, the scoped
 * eval-authoring tools) stay internal; ordinary inspector actions publish.
 * Absent metadata is read as INTERNAL — a new tool is never published by
 * accident.
 *
 * NOT the same thing as the `page_*` namespace: those are tools a real
 * third-party page registered, which MCPJam INSPECTS over CDP (see
 * `shared/client-fulfilled-tools.ts`). `ui_*` is what MCPJam itself offers.
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

export interface UiToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Which agent asked for this call.
 *
 * Load bearing rather than decorative: `ask_mcpjam` calls carry a
 * conversation (a transcript to render into, a session to scope a parked
 * question to, MCPJam's own approval pill), and `native_webmcp` calls carry
 * none of that — the browser owns that agent's approval flow, and there is no
 * conversation to create. A tool that needs one reads this instead of
 * guessing from the absence of a `scope`.
 */
export type UiToolCaller = "ask_mcpjam" | "native_webmcp";

/**
 * Per-call context handed to `execute`, for the tools that need to know WHICH
 * call they are — and on whose behalf — rather than just their arguments.
 *
 * Optional on the signature so the catalog's ordinary tools — and the tests
 * that invoke them directly — keep working with a single argument. Only
 * `executeUiToolCall` (`ui-tool-execution.ts`) supplies it, for both
 * transports.
 */
export interface UiToolExecuteContext {
  /**
   * This invocation's identity: the streamed tool-call id for an Ask MCPJam
   * call, a minted id for a native one. Required by tools that park on user
   * input (`ui_ask_user`): it's the key the rendered card resolves against.
   */
  toolCallId: string;
  /**
   * The caller's chatSessionId — Ask MCPJam only. Lets a parked tool be
   * cancelled per conversation instead of globally, and carries the eval
   * scope. A native call has no conversation, so it has no scope.
   */
  scope?: string;
  /** Which agent asked. */
  caller: UiToolCaller;
  /**
   * Cancellation for this call, when the transport has any. Today only the
   * native publisher supplies one (it aborts when the tool's registration is
   * torn down). Handlers that reach something cancellable should forward it;
   * aborting NEVER un-does an action that already happened.
   */
  signal?: AbortSignal;
}

/**
 * Whether a tool definition may be published to browser-native WebMCP agents
 * (`document.modelContext`), and — when it is — whether its RESULT can carry
 * content MCPJam did not author.
 *
 * Explicit per definition, and shaped like the surface manifest's
 * `agentTools` opt-out, for the same reason: staying out of a channel is a
 * decision with a reason, not an omission. Absent metadata is read as
 * internal by `shouldPublishNatively`, so a new tool is never published by
 * accident.
 */
export type UiToolNativePublication =
  | {
      readonly kind: "publish";
      /**
       * True when the result can contain bytes from somewhere else — a
       * third-party MCP server's tool output, a registry listing, a page.
       * Published as WebMCP's `untrustedContentHint` so an external agent
       * knows to treat the payload as data rather than instructions.
       */
      readonly untrustedContent: boolean;
    }
  | { readonly kind: "internal"; readonly reason: string };

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
   * (`uiToolCallNeedsApproval`). Every entry in the first-party catalog sets
   * these explicitly — an absent `destructiveHint` is read as DESTRUCTIVE
   * (the protocol's pessimistic default), so a tool added without
   * annotations gates rather than executing silently.
   */
  annotations?: UiToolAnnotations;
  /**
   * Executing this tool can change the SPA route (directly, or via the
   * auto-open-playground fallback). Route-bound chat surfaces use this to
   * hand the conversation off to the always-mounted side panel BEFORE the
   * route commits. Client-only metadata — `snapshotForChatBody` never ships
   * it to the server.
   */
  mayNavigate?: boolean;
  /**
   * Whether browser-native WebMCP agents get this tool, and why not when they
   * don't. Client-only metadata — `snapshotForChatBody` never ships it to the
   * server. Absent reads as internal (see `shouldPublishNatively`); the
   * agent-tool coverage test requires every first-party definition to state
   * it outright.
   */
  nativePublication?: UiToolNativePublication;
  execute: (
    args: Record<string, unknown>,
    ctx?: UiToolExecuteContext,
  ) => Promise<UiToolResult>;
}

// Server-mirrored limits for the chat POST snapshot (same as app tools).
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 8 * 1024;

interface UiToolsRegistryState {
  tools: Map<string, UiToolDefinition>;
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
    }
    // Per-registration ownership token. NOT `def` identity: two registrars can
    // share the same module-level `UiToolDefinition` object, so a def-identity
    // guard would let a replaced registration's stale unregister still match
    // (and delete) the replacement. Each register() call mints a fresh token;
    // cleanup only fires while its own token is the live one for the name.
    const ownerToken = Symbol(def.name);
    set((s) => {
      const tools = new Map(s.tools);
      tools.set(def.name, def);
      const globalNames = new Set(s.globalNames);
      if (opts?.scope === "global") globalNames.add(def.name);
      else globalNames.delete(def.name);
      const ownerTokens = new Map(s.ownerTokens);
      ownerTokens.set(def.name, ownerToken);
      return { tools, globalNames, ownerTokens };
    });
    const unregister = () => {
      // Ownership guard: tear down only while OUR registration is still the
      // live one (checked by token, so a shared def object can't confuse it).
      // After a warn+replace, the replaced registration's unregister/abort
      // must not delete the replacement.
      if (get().ownerTokens.get(def.name) !== ownerToken) return;
      get().unregisterUiTool(def.name);
    };
    opts?.signal?.addEventListener("abort", unregister, { once: true });
    return unregister;
  },

  unregisterUiTool: (name) => {
    if (!get().tools.has(name)) return;
    set((s) => {
      const nextTools = new Map(s.tools);
      nextTools.delete(name);
      const nextGlobals = new Set(s.globalNames);
      nextGlobals.delete(name);
      const nextOwnerTokens = new Map(s.ownerTokens);
      nextOwnerTokens.delete(name);
      return {
        tools: nextTools,
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

/**
 * Whether a definition is eligible for browser-native publication.
 *
 * Default-deny: a definition that says nothing stays internal. The cost of
 * that default is a tool an external agent cannot see until someone declares
 * it; the cost of the other default is a conversation-only tool published to
 * an agent that has no conversation, which fails at the far end of a call the
 * user cannot see. The first is a missing feature, the second is a bug.
 */
export function shouldPublishNatively(def: UiToolDefinition): boolean {
  return def.nativePublication?.kind === "publish";
}

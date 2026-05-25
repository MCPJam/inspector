/**
 * App-Provided Tools registry (SEP-1865).
 *
 * Each mounted MCP app iframe gets one entry here, keyed by a per-instance
 * `BridgeId`. Entries hold:
 *   - The `AppBridge` ref used to dispatch `tools/call` into the iframe.
 *   - The tools the app advertised via `tools/list` after `ui/initialize`.
 *   - Opaque aliases (`app_<8hex>`) that act as the model-facing tool names.
 *
 * The registry serves two callers:
 *   - `snapshotForChatBody()` — drained at chat POST time so the server can
 *     register no-execute AI SDK tools that the model can pick.
 *   - `resolve(alias)` — looked up by `useChat.onToolCall` to find the right
 *     bridge to dispatch into.
 *
 * App-provided tools are exposed exactly as the app lists them. MCPJam keeps
 * the readonly bit for attribution and future policy, but does not force its
 * server-tool approval flow onto app-provided tools.
 */

import { create } from "zustand";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

/** Per-AppBridge instance identifier (independent of parentToolCallId). */
export type BridgeId = string;

export type AppToolDescriptor = NonNullable<
  Awaited<ReturnType<AppBridge["listTools"]>>["tools"]
>[number];

export interface AppInstance {
  bridgeId: BridgeId;
  /** The host tool call whose render mounted this iframe. */
  parentToolCallId: string;
  serverId: string;
  appName: string;
  appVersion?: string;
  surface: "inline" | "modal";
  bridge: AppBridge;
  tools: AppToolDescriptor[];
  registeredAtMs: number;
  /**
   * Accessor for the iframe DOM node that hosts this app instance. Lets
   * callers (e.g. `onToolCall`) scroll the iframe into view before
   * dispatching `tools/call`. Optional because legacy callers and tests
   * may not set it.
   */
  getIframeElement?: () => HTMLIFrameElement | null;
}

export interface AppToolAlias {
  alias: string;
  bridgeId: BridgeId;
  rawName: string;
  /** Cached from `annotations.readOnlyHint === true`. */
  readOnly: boolean;
}

/** What the snapshot ships to the server in the chat POST body. */
export interface AppToolSnapshotEntry {
  alias: string;
  appName: string;
  appVersion?: string;
  serverId: string;
  parentToolCallId: string;
  rawName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

// Server-mirrored limits for the chat POST snapshot.
const MAX_SNAPSHOT_ENTRIES = 64;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 8 * 1024;
const ALIAS_REGEX = /^app_[a-z0-9]{8}$/i;

interface AppToolsRegistryState {
  instancesByBridgeId: Map<BridgeId, AppInstance>;
  aliases: Map<string, AppToolAlias>;
  /** Active app-tool provider per host tool call. */
  activeBridgeByParent: Map<string, BridgeId>;
  /**
   * AbortControllers for in-flight `bridge.callTool(...)` dispatches, keyed
   * by the dispatching bridge's id. `unregisterInstance` aborts every
   * controller in the matching set so a torn-down iframe never leaves a
   * paused server stream waiting forever. Each set is also the source of
   * truth for the per-iframe busy indicator.
   */
  pendingControllers: Map<BridgeId, Set<AbortController>>;

  registerInstance: (inst: AppInstance) => Promise<void>;
  unregisterInstance: (bridgeId: BridgeId) => void;
  pushActive: (parentToolCallId: string, bridgeId: BridgeId) => void;
  popActive: (parentToolCallId: string, bridgeId: BridgeId) => void;

  /** Adds `controller` to the bridge's pending set and bumps the busy count. */
  registerPendingCall: (bridgeId: BridgeId, controller: AbortController) => void;
  /** Removes `controller` from the bridge's pending set (no-op if absent). */
  unregisterPendingCall: (
    bridgeId: BridgeId,
    controller: AbortController
  ) => void;

  snapshotForChatBody: () => AppToolSnapshotEntry[];
  resolve: (alias: string) => {
    bridge: AppBridge;
    rawName: string;
    readOnly: boolean;
    instance: AppInstance;
  } | null;
}

/**
 * Produce an opaque alias for a rendered app tool. SHA-256 hashed over stable
 * identity-bearing inputs and truncated to 8 hex chars so the wire
 * name is always 12 chars: well under Anthropic's 64-char tool-name limit
 * and never collides with the `getInvalidAnthropicToolNames` charset.
 *
 * Deliberately exclude `bridgeId`: a live app can reconnect/re-register its
 * bridge without changing the rendered host tool call or raw app-tool name.
 * The alias must stay stable across that churn so the model does not see the
 * same app tool under a fresh name.
 *
 * Collision retry: if a generated alias is already in use, the caller
 * (`registerInstance`) re-rolls with a numeric salt appended to the
 * preimage. In practice 8 hex chars over the joined inputs has negligible
 * collision risk; the retry is a belt-and-suspenders guard.
 */
async function generateAlias(
  serverId: string,
  parentToolCallId: string,
  rawName: string,
  salt = 0
): Promise<string> {
  const preimage = `${serverId}\0${parentToolCallId}\0${rawName}\0${salt}`;
  const bytes = new TextEncoder().encode(preimage);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `app_${hex.slice(0, 8)}`;
}

function isReadOnly(tool: AppToolDescriptor): boolean {
  return tool.annotations?.readOnlyHint === true;
}

export const useAppToolsRegistry = create<AppToolsRegistryState>(
  (set, get) => ({
    instancesByBridgeId: new Map(),
    aliases: new Map(),
    activeBridgeByParent: new Map(),
    pendingControllers: new Map(),

    // Returns a Promise so callers (and tests) can await the alias-hash
    // round-trip. The renderer uses `void registerInstance(...)` because
    // there's nothing to do until the next chat POST. Tests await so
    // resolved microtasks don't bleed into the next test's reset store.
    registerInstance: async (inst) => {
      // Generate aliases for every tool the app listed. `readOnly` is cached
      // from annotations, but it is not an inclusion gate.
      const aliasesForInst: AppToolAlias[] = [];
      const existing = new Set(
        [...get().aliases.entries()]
          .filter(([, alias]) => {
            if (alias.bridgeId === inst.bridgeId) return false;
            const oldInst = get().instancesByBridgeId.get(alias.bridgeId);
            return oldInst?.parentToolCallId !== inst.parentToolCallId;
          })
          .map(([alias]) => alias)
      );
      for (const tool of inst.tools) {
        let salt = 0;
        let alias = await generateAlias(
          inst.serverId,
          inst.parentToolCallId,
          tool.name,
          salt
        );
        while (existing.has(alias)) {
          salt += 1;
          alias = await generateAlias(
            inst.serverId,
            inst.parentToolCallId,
            tool.name,
            salt
          );
        }
        existing.add(alias);
        aliasesForInst.push({
          alias,
          bridgeId: inst.bridgeId,
          rawName: tool.name,
          readOnly: isReadOnly(tool),
        });
      }
      set((s) => {
        const instancesByBridgeId = new Map(s.instancesByBridgeId);
        for (const [bridgeId, oldInst] of s.instancesByBridgeId) {
          if (
            bridgeId !== inst.bridgeId &&
            oldInst.parentToolCallId === inst.parentToolCallId &&
            oldInst.surface === inst.surface
          ) {
            instancesByBridgeId.delete(bridgeId);
          }
        }
        instancesByBridgeId.set(inst.bridgeId, inst);
        const aliases = new Map(s.aliases);
        for (const [alias, a] of s.aliases) {
          const oldInst = s.instancesByBridgeId.get(a.bridgeId);
          if (
            a.bridgeId === inst.bridgeId ||
            oldInst?.parentToolCallId === inst.parentToolCallId
          ) {
            aliases.delete(alias);
          }
        }
        for (const a of aliasesForInst) aliases.set(a.alias, a);
        const activeBridgeByParent = new Map(s.activeBridgeByParent);
        activeBridgeByParent.set(inst.parentToolCallId, inst.bridgeId);
        return { instancesByBridgeId, aliases, activeBridgeByParent };
      });
    },

    unregisterInstance: (bridgeId) => {
      // Abort any in-flight `bridge.callTool` dispatches against this bridge
      // BEFORE we drop the instance entry. The catch branch in
      // `useChat.onToolCall` picks up the abort and resolves the tool call
      // with `isError: true`, which is what lets the paused server stream
      // continue. Skipping this leaves the chat hanging when an iframe is
      // torn down mid-dispatch.
      const pending = get().pendingControllers.get(bridgeId);
      if (pending) {
        for (const controller of pending) {
          try {
            controller.abort();
          } catch {
            // Ignore — abort() should never throw, but defensively continue.
          }
        }
      }
      set((s) => {
        const inst = s.instancesByBridgeId.get(bridgeId);
        if (!inst) return {};
        const instancesByBridgeId = new Map(s.instancesByBridgeId);
        instancesByBridgeId.delete(bridgeId);
        const aliases = new Map(s.aliases);
        for (const [alias, a] of s.aliases) {
          if (a.bridgeId === bridgeId) aliases.delete(alias);
        }
        const activeBridgeByParent = new Map(s.activeBridgeByParent);
        if (activeBridgeByParent.get(inst.parentToolCallId) === bridgeId) {
          activeBridgeByParent.delete(inst.parentToolCallId);
        }
        const pendingControllers = new Map(s.pendingControllers);
        pendingControllers.delete(bridgeId);
        return {
          instancesByBridgeId,
          aliases,
          activeBridgeByParent,
          pendingControllers,
        };
      });
    },

    registerPendingCall: (bridgeId, controller) => {
      set((s) => {
        const pendingControllers = new Map(s.pendingControllers);
        const next = new Set(pendingControllers.get(bridgeId));
        next.add(controller);
        pendingControllers.set(bridgeId, next);
        return { pendingControllers };
      });
    },

    unregisterPendingCall: (bridgeId, controller) => {
      set((s) => {
        const existing = s.pendingControllers.get(bridgeId);
        if (!existing || !existing.has(controller)) return {};
        const pendingControllers = new Map(s.pendingControllers);
        if (existing.size === 1) {
          pendingControllers.delete(bridgeId);
        } else {
          const next = new Set(existing);
          next.delete(controller);
          pendingControllers.set(bridgeId, next);
        }
        return { pendingControllers };
      });
    },

    pushActive: (parentToolCallId, bridgeId) => {
      set((s) => {
        const next = new Map(s.activeBridgeByParent);
        next.set(parentToolCallId, bridgeId);
        return { activeBridgeByParent: next };
      });
    },

    popActive: (parentToolCallId, bridgeId) => {
      set((s) => {
        const current = s.activeBridgeByParent.get(parentToolCallId);
        if (current !== bridgeId) return {};
        const next = new Map(s.activeBridgeByParent);
        // Fall back to any other registered instance under this parent.
        let fallback: BridgeId | undefined;
        for (const inst of s.instancesByBridgeId.values()) {
          if (
            inst.parentToolCallId === parentToolCallId &&
            inst.bridgeId !== bridgeId
          ) {
            fallback = inst.bridgeId;
            break;
          }
        }
        if (fallback) next.set(parentToolCallId, fallback);
        else next.delete(parentToolCallId);
        return { activeBridgeByParent: next };
      });
    },

    snapshotForChatBody: () => {
      const { instancesByBridgeId, aliases, activeBridgeByParent } = get();
      const out: AppToolSnapshotEntry[] = [];
      let dropped = 0;
      for (const [alias, a] of aliases) {
        if (out.length >= MAX_SNAPSHOT_ENTRIES) {
          dropped += 1;
          continue;
        }
        if (!ALIAS_REGEX.test(alias)) continue;
        const inst = instancesByBridgeId.get(a.bridgeId);
        if (!inst) continue;
        // Only the active instance per parent contributes. This prevents stale
        // iframe instances from advertising tools after a modal or replay wins.
        if (activeBridgeByParent.get(inst.parentToolCallId) !== inst.bridgeId) {
          continue;
        }
        const tool = inst.tools.find((t) => t.name === a.rawName);
        if (!tool) continue;
        let inputSchema = tool.inputSchema;
        if (inputSchema) {
          let size = 0;
          try {
            size = new TextEncoder().encode(JSON.stringify(inputSchema)).length;
          } catch {
            continue; // unserializable
          }
          if (size > MAX_INPUT_SCHEMA_BYTES) continue;
        }
        const description = tool.description
          ? tool.description.slice(0, MAX_DESCRIPTION_CHARS)
          : undefined;
        out.push({
          alias,
          appName: inst.appName,
          appVersion: inst.appVersion,
          serverId: inst.serverId,
          parentToolCallId: inst.parentToolCallId,
          rawName: a.rawName,
          description,
          inputSchema,
          readOnly: a.readOnly,
        });
      }
      if (dropped > 0) {
        console.warn(
          `[app-tools] snapshot capped at ${MAX_SNAPSHOT_ENTRIES} entries; dropped ${dropped}.`
        );
      }
      // Multi-instance disambiguation: when the same app is mounted more
      // than once concurrently (e.g. two tic-tac-toe boards from two
      // separate `tools/call` results), `tools/list` returns identical
      // `rawName`s and the model sees N tools with the same description.
      // Wire-level routing is already correct (aliases differ per
      // parentToolCallId), but the model can't tell which instance to
      // pick. Append `(from tool call <id>; instance N of M)` to the
      // description for any group with size > 1 so the model can
      // distinguish them via the visible tool-call history in the
      // transcript. Singletons stay untouched.
      const groupCounts = new Map<string, number>();
      for (const entry of out) {
        const key = `${entry.appName}\0${entry.rawName}`;
        groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
      }
      const groupIndex = new Map<string, number>();
      for (const entry of out) {
        const key = `${entry.appName}\0${entry.rawName}`;
        const total = groupCounts.get(key) ?? 1;
        if (total <= 1) continue;
        const n = (groupIndex.get(key) ?? 0) + 1;
        groupIndex.set(key, n);
        const hint = ` (from tool call ${entry.parentToolCallId}; instance ${n} of ${total})`;
        const base = entry.description ?? "";
        entry.description = (base + hint).slice(0, MAX_DESCRIPTION_CHARS);
      }
      return out;
    },

    resolve: (alias) => {
      const a = get().aliases.get(alias);
      if (!a) return null;
      const inst = get().instancesByBridgeId.get(a.bridgeId);
      if (!inst) return null;
      if (get().activeBridgeByParent.get(inst.parentToolCallId) !== inst.bridgeId) {
        return null;
      }
      return {
        bridge: inst.bridge,
        rawName: a.rawName,
        readOnly: a.readOnly,
        instance: inst,
      };
    },
  })
);

/**
 * Side-channel log of every app-tool invocation for debugging and future UI.
 * Mirrors the widget-html debug store pattern. The full untouched
 * `CallToolResult` is stored here so the UI can later display
 * `structuredContent` / `_meta` that were intentionally stripped from model
 * context.
 */
export interface AppToolInvocationRecord {
  alias: string;
  rawName: string;
  appName: string;
  serverId: string;
  parentToolCallId: string;
  bridgeId: BridgeId;
  input: unknown;
  raw: CallToolResult;
  invokedAtMs: number;
}

interface AppToolInvocationLogState {
  records: AppToolInvocationRecord[];
  append: (r: AppToolInvocationRecord) => void;
  clear: () => void;
}

const MAX_INVOCATION_RECORDS = 200;

export const useAppToolInvocationLog = create<AppToolInvocationLogState>(
  (set) => ({
    records: [],
    append: (r) =>
      set((s) => {
        const next = s.records.concat(r);
        if (next.length > MAX_INVOCATION_RECORDS) {
          next.splice(0, next.length - MAX_INVOCATION_RECORDS);
        }
        return { records: next };
      }),
    clear: () => set({ records: [] }),
  })
);

export function recordAppToolInvocation(
  args: Omit<AppToolInvocationRecord, "invokedAtMs">
): void {
  useAppToolInvocationLog.getState().append({
    ...args,
    invokedAtMs: Date.now(),
  });
  // Mirror the invocation into the shared traffic-log store so it
  // surfaces in `LoggerView` alongside the rest of the iframe ↔ host
  // traffic. `direction: "host-to-ui"` because the host dispatched the
  // call into the iframe via `bridge.callTool`. `widgetId` matches the
  // parent host tool call so existing logger filters scope correctly.
  // Only the model-safe scrubbed payload is shipped here — the full
  // `CallToolResult` (including `structuredContent` and `_meta`) lives
  // in `useAppToolInvocationLog` for richer debug UIs.
  try {
    useTrafficLogStore.getState().addLog({
      widgetId: args.parentToolCallId,
      serverId: args.serverId,
      direction: "host-to-ui",
      protocol: "mcp-apps",
      method: "tools/call",
      message: {
        alias: args.alias,
        toolName: args.rawName,
        appName: args.appName,
        arguments: args.input,
        result: {
          content: args.raw.content,
          ...(args.raw.isError ? { isError: true } : {}),
        },
      },
    });
  } catch {
    // Defensive: the traffic-log store is best-effort observability;
    // never let a logger failure bubble into the dispatch path.
  }
}

// Exports for tests.
export const __internal = { generateAlias, isReadOnly, ALIAS_REGEX };

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

  registerInstance: (inst: AppInstance) => Promise<void>;
  unregisterInstance: (bridgeId: BridgeId) => void;
  pushActive: (parentToolCallId: string, bridgeId: BridgeId) => void;
  popActive: (parentToolCallId: string, bridgeId: BridgeId) => void;

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
        return { instancesByBridgeId, aliases, activeBridgeByParent };
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
}

// Exports for tests.
export const __internal = { generateAlias, isReadOnly, ALIAS_REGEX };

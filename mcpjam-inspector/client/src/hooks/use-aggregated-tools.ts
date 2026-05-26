import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Tool } from "@modelcontextprotocol/client";
import { listTools } from "@/lib/apis/mcp-tools-api";
import {
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";

export interface ServerScopedTool {
  serverId: string;
  toolName: string;
  tool: Tool;
}

export interface AggregatedToolsState {
  /** Tools grouped by their serving `serverId`. */
  toolsByServer: Record<string, Tool[]>;
  /** Flat list, one entry per (serverId, toolName) pair. */
  flat: ServerScopedTool[];
  /** Names that appear on more than one server. */
  collidingNames: string[];
  /** Loading state per server (so the UI can show partial progress). */
  loadingByServer: Record<string, boolean>;
  /** Per-server fetch error (string message), if any. */
  errorByServer: Record<string, string>;
  refetch: () => Promise<void>;
}

/**
 * Aggregates tool lists across several MCP servers for the Playground tools
 * pane.
 *
 * Unlike `getToolsMetadata` (which flattens metadata into bare-name maps for
 * LLM consumption), this hook keeps tools grouped by server so the UI can:
 *   - render a section-per-server tree with badges (matching the convention
 *     established in `tool-choice-picker.tsx:204`)
 *   - resolve clicks to a `(serverId, toolName)` tuple, avoiding the
 *     last-seen-wins collision behavior baked into `ToolServerMap`.
 */
export function useAggregatedTools(
  serverNames: string[]
): AggregatedToolsState {
  const apiContextRevision = useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision
  );
  const [toolsByServer, setToolsByServer] = useState<Record<string, Tool[]>>(
    {}
  );
  const [loadingByServer, setLoadingByServer] = useState<
    Record<string, boolean>
  >({});
  const [errorByServer, setErrorByServer] = useState<Record<string, string>>(
    {}
  );

  // Stable key so the effect doesn't re-run when the parent passes a fresh
  // array reference with the same contents. \x00 is a safe delimiter — it
  // can't appear inside a serverName.
  const serversKey = useMemo(
    () => [...serverNames].sort().join("\x00"),
    [serverNames]
  );
  const serverNamesRef = useRef<string[]>([]);
  serverNamesRef.current = serversKey ? serversKey.split("\x00") : [];

  // Monotonic token so a stale in-flight fetch can't clobber a fresher result
  // when the server set toggles or `refetch` is called mid-request.
  const fetchTokenRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const names = serverNamesRef.current;
    const token = ++fetchTokenRef.current;
    if (names.length === 0) {
      setToolsByServer({});
      setLoadingByServer({});
      setErrorByServer({});
      return;
    }

    // Prune state to the new server set synchronously so tools from
    // just-deselected servers disappear immediately rather than lingering
    // until the new fetch returns.
    const activeSet = new Set(names);
    const pruneToActive = <V>(prev: Record<string, V>): Record<string, V> => {
      const next: Record<string, V> = {};
      for (const key of Object.keys(prev)) {
        if (activeSet.has(key)) next[key] = prev[key];
      }
      return next;
    };
    setToolsByServer((prev) => pruneToActive(prev));
    setErrorByServer((prev) => pruneToActive(prev));
    setLoadingByServer((prev) => {
      const next = pruneToActive(prev);
      for (const name of names) next[name] = true;
      return next;
    });

    const results = await Promise.all(
      names.map(async (serverId) => {
        try {
          const data = await listTools({ serverId });
          return { serverId, tools: data.tools ?? [], error: null as null };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to fetch tools";
          return { serverId, tools: [], error: message };
        }
      })
    );

    if (token !== fetchTokenRef.current) return;

    setToolsByServer(() => {
      const next: Record<string, Tool[]> = {};
      for (const { serverId, tools } of results) next[serverId] = tools;
      return next;
    });
    setErrorByServer(() => {
      const next: Record<string, string> = {};
      for (const { serverId, error } of results) {
        if (error) next[serverId] = error;
      }
      return next;
    });
    setLoadingByServer(() => {
      const next: Record<string, boolean> = {};
      for (const { serverId } of results) next[serverId] = false;
      return next;
    });
  }, [serversKey, apiContextRevision]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const flat = useMemo<ServerScopedTool[]>(() => {
    const entries: ServerScopedTool[] = [];
    for (const [serverId, tools] of Object.entries(toolsByServer)) {
      for (const tool of tools) {
        entries.push({ serverId, toolName: tool.name, tool });
      }
    }
    return entries;
  }, [toolsByServer]);

  const collidingNames = useMemo(() => {
    const seen = new Map<string, Set<string>>();
    for (const { serverId, toolName } of flat) {
      const servers = seen.get(toolName) ?? new Set<string>();
      servers.add(serverId);
      seen.set(toolName, servers);
    }
    return Array.from(seen.entries())
      .filter(([, servers]) => servers.size > 1)
      .map(([name]) => name);
  }, [flat]);

  return {
    toolsByServer,
    flat,
    collidingNames,
    loadingByServer,
    errorByServer,
    refetch: fetchAll,
  };
}

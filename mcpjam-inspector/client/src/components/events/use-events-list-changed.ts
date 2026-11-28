import { useEffect, useRef } from "react";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { watchEventsCatalog } from "@/lib/apis/mcp-events-api";

export const EVENTS_LIST_CHANGED = "notifications/events/list_changed";

/**
 * Calls `onChange` when the server's `notifications/events/list_changed`
 * shows up in the Logs stream, so the catalog is read again. Only messages
 * received after mount count; a burst becomes one call.
 */
export function useEventsListChanged(
  serverName: string | undefined,
  onChange: () => void,
  beta = false,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!serverName) return;
    if (beta) {
      const abort = new AbortController();
      void watchEventsCatalog(serverName, abort.signal, () => onChangeRef.current());
      return () => abort.abort();
    }
    let seen = new Set(
      useTrafficLogStore.getState().mcpServerItems.map((item) => item.id),
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useTrafficLogStore.subscribe((state) => {
      let changed = false;
      // Newest first: stop at the first item already seen.
      for (const item of state.mcpServerItems) {
        if (seen.has(item.id)) break;
        seen.add(item.id);
        if (
          item.method === EVENTS_LIST_CHANGED &&
          (item.serverId === serverName || item.serverName === serverName)
        ) {
          changed = true;
        }
      }
      if (seen.size > 4096) {
        seen = new Set(state.mcpServerItems.map((item) => item.id));
      }
      if (changed && !timer) {
        timer = setTimeout(() => {
          timer = null;
          onChangeRef.current();
        }, 150);
      }
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [serverName, beta]);
}

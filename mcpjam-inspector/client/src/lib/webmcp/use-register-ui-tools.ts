/**
 * Mount-scoped registration of the WebMCP UI tool catalog.
 *
 * Mounted once near the App root (beside the inspector command handlers, in
 * BOTH local and hosted modes). Registration feeds a single consumer: the UI
 * tools registry, whose snapshot/executor serve the in-app "Ask MCPJam"
 * agent. Tools are never exposed to browser-native agents. Cleanup aborts
 * everything.
 *
 * Pass `enabled: false` on surfaces whose end user is not the inspector
 * operator (the standalone chatbox chat route): inspector-driving tools must
 * not exist on that page at all. Toggling `enabled` registers/unregisters
 * accordingly.
 */

import { useEffect } from "react";
import { buildUiToolsCatalog } from "./ui-tools-catalog";
import { useUiToolsRegistry } from "./ui-tools-registry";

export function useRegisterUiTools(options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const registerUiTool = useUiToolsRegistry.getState().registerUiTool;
    for (const def of buildUiToolsCatalog()) {
      // Global scope: the app-wide catalog must survive the snapshot's
      // 64-entry cap ahead of any surface-scoped registrations.
      registerUiTool(def, { signal: controller.signal, scope: "global" });
    }
    return () => controller.abort();
  }, [enabled]);
}

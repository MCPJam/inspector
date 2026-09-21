/**
 * Mount-scoped registration of the always-on `ui_*` tool catalog.
 *
 * Mounted once near the App root (beside the inspector command handlers, in
 * BOTH local and hosted modes). Registration feeds ONE destination: the UI
 * tools registry. Who reads the registry is not this hook's business — today
 * that is Ask MCPJam's snapshot/executor and the native publisher
 * (`use-publish-native-ui-tools.ts`), which mirrors the publishable entries
 * onto `document.modelContext`. Cleanup aborts everything, which removes the
 * tools from both.
 *
 * Pass `enabled: false` on surfaces whose end user is not the inspector
 * operator (the standalone scenario chat route): inspector-driving tools must
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

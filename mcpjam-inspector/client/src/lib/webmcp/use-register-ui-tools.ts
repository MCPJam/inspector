/**
 * Mount-scoped registration of the WebMCP UI tool catalog.
 *
 * Mounted once near the App root (beside the inspector command handlers, in
 * BOTH local and hosted modes). Registration feeds two consumers at once:
 * the UI tools registry (snapshotted into every chat POST) and, via the
 * registry's native mirror, the browser's `modelContext` for browser-native
 * agents. Cleanup aborts everything, which also disposes the native mirrors.
 *
 * Pass `enabled: false` on surfaces whose end user is not the inspector
 * operator (the standalone chatbox chat route): inspector-driving tools must
 * not exist there at all — neither in chat POST snapshots nor mirrored to the
 * native modelContext. Toggling `enabled` registers/unregisters accordingly.
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
      registerUiTool(def, { signal: controller.signal });
    }
    return () => controller.abort();
  }, [enabled]);
}

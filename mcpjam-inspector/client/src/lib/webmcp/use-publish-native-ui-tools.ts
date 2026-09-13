/**
 * Mount-scoped publication of MCPJam's UI tools to browser-native WebMCP
 * agents.
 *
 * Mounted ONCE at the App root, beside `useRegisterUiTools`, in both local
 * and hosted modes. The two are deliberately separate hooks: one fills the
 * registry with the always-on catalog, this one mirrors whatever the registry
 * holds — catalog plus whichever surface group is mounted — onto
 * `document.modelContext`. That is why this hook subscribes rather than
 * registering a fixed list: a surface's tools have to appear and disappear
 * with its screen without the App root knowing anything about surfaces.
 *
 * `enabled: false` is the same exclusion the internal registration uses: on
 * the standalone scenario chat route the end user is not the inspector
 * operator, so inspector-driving tools must not exist on that page — for
 * either agent.
 *
 * No opt-in beyond that, and no MCPJam approval prompt: where the browser has
 * the API, the tools are published; where it does not, nothing happens and
 * Ask MCPJam is unaffected.
 */

import { useEffect } from "react";
import { startNativeUiToolPublisher } from "./native-tool-publisher";

export function usePublishNativeUiTools(options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const publisher = startNativeUiToolPublisher();
    // StrictMode runs setup/cleanup/setup: stop() retires this publisher's
    // registrations and the second setup makes fresh ones. The publisher's
    // per-name serialization is what keeps that from colliding with the
    // browser's duplicate-name rejection.
    return () => publisher.stop();
  }, [enabled]);
}

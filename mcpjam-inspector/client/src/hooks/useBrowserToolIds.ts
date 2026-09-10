import { useMemo } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { resolveLocalBrowserTools } from "@/shared/local-browser-settings";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

export function useBrowserToolIds(config: HostConfigDtoV2 | null | undefined, engine: "local" | "cloud") {
  return useMemo(() => resolveLocalBrowserTools(
    config?.builtInToolIds,
    config?.localBrowserEnabled,
    !HOSTED_MODE && engine === "local",
  ), [config?.builtInToolIds, config?.localBrowserEnabled, engine]);
}

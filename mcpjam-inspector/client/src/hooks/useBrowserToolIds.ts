import { useMemo } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { resolveLocalBrowserTools } from "@/shared/local-browser-settings";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { useAuth } from "@workos-inc/authkit-react";
import { useLocalBrowserConsent } from "./useLocalBrowserConsent";

export function useBrowserToolIds(
  config: HostConfigDtoV2 | null | undefined,
  engine: "local" | "cloud",
) {
  const { user } = useAuth();
  const consent = useLocalBrowserConsent();
  // Guest clients have no shared project setting to update. Their explicit
  // device grant supplies the local default, including views in other tabs.
  const enabled =
    config?.localBrowserEnabled ??
    (!user && consent.granted ? true : undefined);
  return useMemo(
    () =>
      resolveLocalBrowserTools(
        config?.builtInToolIds,
        enabled,
        !HOSTED_MODE && engine === "local",
      ),
    [config?.builtInToolIds, enabled, engine],
  );
}

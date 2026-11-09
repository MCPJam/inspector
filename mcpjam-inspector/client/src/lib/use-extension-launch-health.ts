import { useEffect, useMemo } from "react";
import { ExtensionLaunchHealth } from "./extension-launch-health";

/** Keep launch tombstones with their owner, including a StrictMode remount. */
export function useExtensionLaunchHealth(owner: string | null) {
  const lifetime = useMemo(
    () => ({
      health: new ExtensionLaunchHealth(),
      mounted: 0,
    }),
    [owner],
  );
  useEffect(() => {
    lifetime.mounted++;
    return () => {
      lifetime.mounted--;
      queueMicrotask(() => {
        if (!lifetime.mounted) lifetime.health.dispose("cancelled");
      });
    };
  }, [lifetime]);
  return lifetime.health;
}

/** Observe discovery only when the person actually opens the settings entry. */
export function useSettingsLaunchObservation(
  owner: string,
  profile: import("./extension-launch-health").ExtensionLaunchProfile,
  active: boolean,
  discoveryFailed: boolean,
) {
  const health = useExtensionLaunchHealth(owner);
  const launch = useMemo(
    () => health.begin("settings", "settings", profile),
    [health, profile],
  );
  useEffect(() => {
    if (active && discoveryFailed) launch.fail("execution");
  }, [active, discoveryFailed, launch]);
  return launch;
}

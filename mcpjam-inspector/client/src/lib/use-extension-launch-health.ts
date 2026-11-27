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

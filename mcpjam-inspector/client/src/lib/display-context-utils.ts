import type { DisplayContext } from "@/hooks/useViews";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

/**
 * Hook that returns the current DisplayContext from the UI Playground store.
 */
export function useCurrentDisplayContext(): DisplayContext {
  const deviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const globals = useUIPlaygroundStore((s) => s.globals);
  const capabilities = useUIPlaygroundStore((s) => s.capabilities);
  const safeAreaInsets = useUIPlaygroundStore((s) => s.safeAreaInsets);

  return {
    theme: globals.theme,
    displayMode: globals.displayMode,
    deviceType: deviceType === "custom" ? undefined : deviceType,
    viewport:
      deviceType === "custom"
        ? { width: customViewport.width, height: customViewport.height }
        : undefined,
    locale: globals.locale,
    timeZone: globals.timeZone,
    capabilities,
    safeAreaInsets,
  };
}

/**
 * Compares two DisplayContext objects for equality.
 */
export function areDisplayContextsEqual(
  a: DisplayContext | undefined,
  b: DisplayContext | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

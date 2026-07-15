import { createContext, useContext, type ReactNode } from "react";
import type { WidgetHost } from "./widget-host";

// The package owns the `WidgetHost` React context + hook contract. The inspector
// keeps the concrete host implementation (`use-widget-host.ts`, which reads its
// stores/contexts) and feeds it through `<WidgetHostProvider>`. This is the
// inversion the renderer relocation (3d) relies on: the moved renderer calls the
// package's `useWidgetHost()` instead of the inspector's composite hook.

const WidgetHostContext = createContext<WidgetHost | null>(null);

export interface WidgetHostProviderProps {
  /** The concrete host the inspector builds from its stores/contexts. */
  value: WidgetHost;
  children: ReactNode;
}

export function WidgetHostProvider({
  value,
  children,
}: WidgetHostProviderProps) {
  return (
    <WidgetHostContext.Provider value={value}>
      {children}
    </WidgetHostContext.Provider>
  );
}

/**
 * Read the injected {@link WidgetHost}. Throws if no `<WidgetHostProvider>` is
 * mounted above — the package never reaches into inspector state itself, so a
 * missing provider is a wiring bug, not a fallback.
 */
export function useWidgetHost(): WidgetHost {
  const host = useContext(WidgetHostContext);
  if (host === null) {
    throw new Error(
      "useWidgetHost must be used within a <WidgetHostProvider>. The inspector " +
        "supplies the concrete host via its use-widget-host adapter.",
    );
  }
  return host;
}

import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

/**
 * `onConnect` reaches the Tools rail's empty state through the hook's return
 * value, and the rail keys its Servers-navigation fallback on the field being
 * absent. Types cover an omitted field — `UsePlaygroundStateReturn` is
 * `ReturnType<typeof usePlaygroundState>`, so dropping it fails the rail's
 * destructure at compile time — but not a same-signature mis-wire. Returning
 * the coalesced `onConnect ?? (() => {})` handed to `useOnboarding` two hundred
 * lines up typechecks and makes the field always truthy, which would open the
 * modal on surfaces that supply no handler (the Evals embedded chat) instead of
 * routing them to Servers.
 */

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useAction: () => vi.fn(),
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

import { usePlaygroundState } from "../use-playground-state";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider>{children}</SidebarProvider>
    </PreferencesStoreProvider>
  );
}

describe("usePlaygroundState — onConnect pass-through", () => {
  it("returns the caller's handler by identity", () => {
    const onConnect = vi.fn();

    const { result } = renderHook(() => usePlaygroundState({ onConnect }), {
      wrapper,
    });

    expect(result.current.onConnect).toBe(onConnect);
  });

  it("leaves onConnect undefined when the caller supplies none", () => {
    const { result } = renderHook(() => usePlaygroundState({}), { wrapper });

    expect(result.current.onConnect).toBeUndefined();
  });
});

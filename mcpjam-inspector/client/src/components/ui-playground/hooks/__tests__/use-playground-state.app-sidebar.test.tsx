import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

/**
 * The Playground must not force the APP sidebar open.
 *
 * It used to, on mount and on unmount, as part of restoring chrome after
 * first-run onboarding. That silently defeated `SidebarAutoCollapse`: the
 * Playground route mounts a commit later than the policy's effect, so its
 * layout effect re-expanded the rail the policy had just collapsed — Evaluate
 * collapsed and Playground did not. Onboarding hides the sidebar via the
 * `hidden` prop, never by closing it, so nothing here needs to reopen it.
 */

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useAction: () => vi.fn(),
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

import { usePlaygroundState } from "../use-playground-state";

function PlaygroundHost() {
  usePlaygroundState({});
  return null;
}

function OpenProbe() {
  const { open } = useSidebar();
  return <span data-testid="open">{open ? "open" : "closed"}</span>;
}

/**
 * The provider outlives the route in the real tree, so it stays mounted here
 * while the Playground consumer comes and goes.
 */
function Shell({ playgroundMounted }: { playgroundMounted: boolean }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider defaultOpen={false}>
        <OpenProbe />
        {playgroundMounted ? <PlaygroundHost /> : null}
      </SidebarProvider>
    </PreferencesStoreProvider>
  );
}

const state = () => screen.getByTestId("open").textContent;

describe("usePlaygroundState — app sidebar", () => {
  it("leaves a collapsed app sidebar collapsed on mount", () => {
    render(<Shell playgroundMounted={true} />);

    expect(state()).toBe("closed");
  });

  it("does not reopen the app sidebar when the Playground unmounts", () => {
    const view = render(<Shell playgroundMounted={true} />);
    expect(state()).toBe("closed");

    view.rerender(<Shell playgroundMounted={false} />);

    expect(state()).toBe("closed");
  });
});

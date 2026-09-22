import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalLiveChatPanel } from "../eval-live-chat-panel";

vi.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/lib/host-compat/use-host-catalog", () => ({ useHostCatalog: () => ({ catalog: null }) }));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
  useOptionalSharedAppState: () => null,
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: any) => unknown) => selector({
    themeMode: "dark", hostStyle: "claude",
    hostCapabilitiesOverride: { tools: {} }, chatUiOverride: { label: "Recorder" },
  }),
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundState: () => ({}),
  PlaygroundStateProvider: ({ children }: any) => children,
}));
vi.mock("@/components/ui-playground/PlaygroundMain", async () => {
  const style = await import("@/contexts/scenario-client-style-context");
  const caps = await import("@/contexts/scenario-client-capabilities-override-context");
  const profile = await import("@/contexts/active-mcp-profile-context");
  return { PlaygroundMain: () => <output data-testid="values">{JSON.stringify({
    style: style.useScenarioHostStyle(), theme: style.useScenarioHostTheme(),
    chatUi: style.useScenarioChatUiOverride(), capabilities: caps.useScenarioHostCapabilitiesOverride(),
    profile: profile.useActiveMcpProfile(),
  })}</output> };
});

describe("EvalLiveChatPanel host shell", () => {
  it("preserves preference overrides and the bounded dark shell", () => {
    const { container } = render(<EvalLiveChatPanel />);
    expect(JSON.parse(screen.getByTestId("values").textContent!)).toEqual({
      style: "claude", theme: "dark", chatUi: { label: "Recorder" }, capabilities: { tools: {} },
    });
    expect(container.querySelector("[data-host-style='claude']")).toHaveClass(
      "dark", "h-full", "min-h-0", "flex-1", "overflow-hidden",
    );
  });
});

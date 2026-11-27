import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScenarioHostStyleProvider } from "@/contexts/scenario-client-style-context";
import { PlaygroundTerminalPresentationProvider } from "@/contexts/playground-terminal-presentation";
import { UserMessageBubble } from "../user-message-bubble";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => selector({ themeMode: "light" }),
}));

describe("UserMessageBubble in a Playground terminal client", () => {
  it.each([
    ["claude-code", "❯"],
    ["codex", "›"],
  ])("prefixes the prompt with the %s glyph", (hostStyle, prompt) => {
    render(
      <ScenarioHostStyleProvider value={hostStyle}>
        <PlaygroundTerminalPresentationProvider value>
          <UserMessageBubble>Find AirPods</UserMessageBubble>
        </PlaygroundTerminalPresentationProvider>
      </ScenarioHostStyleProvider>,
    );
    expect(screen.getByText(prompt)).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByText("Find AirPods").closest("[data-terminal-client]"),
    ).toHaveAttribute("data-terminal-client", hostStyle);
  });

  it("keeps the chat bubble outside Playground", () => {
    render(
      <ScenarioHostStyleProvider value="claude-code">
        <UserMessageBubble>Find AirPods</UserMessageBubble>
      </ScenarioHostStyleProvider>,
    );
    expect(
      screen.getByText("Find AirPods").closest("[data-terminal-client]"),
    ).toBeNull();
    expect(screen.queryByText("❯")).toBeNull();
  });
});

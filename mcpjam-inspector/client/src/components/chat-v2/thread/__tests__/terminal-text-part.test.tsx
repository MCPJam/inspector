import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScenarioHostStyleProvider } from "@/contexts/scenario-client-style-context";
import { TextPart } from "../parts/text-part";

describe("terminal replies", () => {
  it.each([
    ["claude-code", "claude-code", "⏺"],
    ["codex", "codex", "•"],
    ["codex-cli", "codex", "•"],
  ])(
    "renders an emitted Markdown table as a table for %s",
    (hostStyle, terminal, marker) => {
      const text = "| Product | Price |\n| --- | ---: |\n| AirPods | $129 |";
      render(
        <ScenarioHostStyleProvider value={hostStyle}>
          <TextPart role="assistant" text={text} showTerminalMarker />
        </ScenarioHostStyleProvider>,
      );

      const table = screen.getByRole("table");
      expect(table.closest("[data-terminal-markdown]")).toHaveAttribute(
        "data-terminal-markdown",
        terminal,
      );
      expect(
        within(table).getByRole("columnheader", { name: "Product" }),
      ).toBeVisible();
      expect(within(table).getByRole("cell", { name: "$129" })).toBeVisible();
      expect(screen.getByText(marker)).toHaveAttribute("aria-hidden", "true");
    },
  );

  it("preserves a list reply and leaves the graphical Claude client in its regular style", () => {
    const text = "- AirPods\n- Price: $129";
    const { rerender } = render(
      <ScenarioHostStyleProvider value="claude-code">
        <TextPart role="assistant" text={text} showTerminalMarker />
      </ScenarioHostStyleProvider>,
    );
    expect(
      screen.getByText("AirPods").closest("[data-terminal-markdown]"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    rerender(
      <ScenarioHostStyleProvider value="claude">
        <TextPart role="assistant" text={text} showTerminalMarker />
      </ScenarioHostStyleProvider>,
    );
    expect(
      screen.getByText("AirPods").closest("[data-terminal-markdown]"),
    ).toBeNull();
    expect(screen.getByRole("list")).toBeVisible();
  });
});

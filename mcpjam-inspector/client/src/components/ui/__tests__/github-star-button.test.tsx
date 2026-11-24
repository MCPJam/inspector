import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { GitHubStarButton } from "../github-star-button";

describe("GitHubStarButton", () => {
  it("shows a tooltip on hover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    render(
      <TooltipProvider delayDuration={0}>
        <GitHubStarButton location="header" />
      </TooltipProvider>,
    );
    await userEvent.hover(
      screen.getByRole("link", { name: "Star MCPJam/inspector on GitHub" }),
    );
    expect(
      (await screen.findAllByText("Star us on GitHub")).length,
    ).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("hides the Star label below the sm breakpoint", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    render(
      <TooltipProvider delayDuration={0}>
        <GitHubStarButton location="header" />
      </TooltipProvider>,
    );
    expect(screen.getByText("Star")).toHaveClass("hidden", "sm:inline");
    vi.unstubAllGlobals();
  });
});

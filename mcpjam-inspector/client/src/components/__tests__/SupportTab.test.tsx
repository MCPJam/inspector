import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SupportTab } from "../SupportTab";

describe("Support settings", () => {
  it("provides help destinations within the settings content frame", () => {
    render(<SupportTab />);
    expect(screen.getByRole("heading", { name: "Support", level: 1 })).toBeInTheDocument();
    expect(document.getElementById("settings-content")).toBeInTheDocument();
    for (const [name, href] of [
      ["Join Discord", "https://discord.gg/JEnDtz8X6z"],
      ["Open Docs", "https://docs.mcpjam.com/"],
      ["Open Issue", "https://github.com/MCPJam/inspector/issues/new"],
    ]) {
      const link = screen.getByRole("link", {
        name: (accessibleName) =>
          accessibleName.replace(/\s*\(opens in a new tab\)$/, "") === name,
      });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByRole("link", { name: "founders@mcpjam.com" })).toHaveAttribute("href", "mailto:founders@mcpjam.com");
  });
});

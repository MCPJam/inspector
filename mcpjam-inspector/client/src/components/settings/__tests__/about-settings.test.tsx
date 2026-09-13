import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AboutSettings } from "../AboutSettings";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it("shows app identity, cached GitHub stars, version, and resource links", () => {
  vi.stubGlobal("__APP_VERSION__", "3.5.3");
  sessionStorage.setItem(
    "gh-stars:MCPJam/inspector",
    JSON.stringify({ count: 2200, ts: Date.now() }),
  );
  render(<AboutSettings />);
  expect(
    screen.getByRole("heading", { name: "About MCPJam", level: 1 }),
  ).toBeInTheDocument();
  expect(screen.getByText("v3.5.3")).toBeInTheDocument();
  expect(screen.getByText("2.2k")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Star MCPJam/inspector on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/MCPJam/inspector");
  expect(screen.getByRole("link", { name: /Website/ })).toHaveAttribute(
    "href",
    "https://www.mcpjam.com",
  );
  expect(screen.getByRole("link", { name: /Trust center/ })).toHaveAttribute(
    "href",
    "https://trust.mcpjam.com",
  );
});

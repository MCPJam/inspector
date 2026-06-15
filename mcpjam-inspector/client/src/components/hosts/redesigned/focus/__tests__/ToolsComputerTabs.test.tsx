import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";

// Catalog with one GA tool (Web Search) plus a computer-backed tool (Bash),
// so we can exercise both the plain row and the requiresComputer gating.
vi.mock("@/hooks/useBuiltInToolCatalog", () => ({
  useBuiltInToolCatalog: () => [
    {
      id: "web_search",
      displayLabel: "Web Search",
      description: "Search the web via Exa.",
      category: "search",
      billable: true,
    },
    {
      id: "bash",
      displayLabel: "Bash",
      description: "Run shell commands on your personal computer.",
      category: "code",
      billable: false,
      requiresComputer: true,
    },
  ],
}));
// Flag on so computer-backed rows (Bash) are visible in the Tools tab.
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
  useFeatureFlagEnabled: () => true,
}));

import { ToolsTab } from "../ToolsTab";
import { ComputerTab } from "../ComputerTab";

describe("ToolsTab", () => {
  it("renders system tools as minimal switch rows", () => {
    render(
      <ToolsTab draft={emptyHostConfigInputV2()} onDraftChange={vi.fn()} />,
    );
    expect(screen.getByText("System tools")).toBeInTheDocument();
    expect(
      screen.getByText("First-party capabilities beyond MCP servers."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Web Search" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Bash" })).toBeInTheDocument();
    expect(screen.queryByText(/Search the web via Exa/i)).toBeNull();
    expect(screen.queryByText("Attached")).toBeNull();
  });

  it("points the Bash block reason at the Computer tab when no computer is attached", () => {
    render(
      <ToolsTab draft={emptyHostConfigInputV2()} onDraftChange={vi.fn()} />,
    );
    expect(
      screen.getByText(/attach it in the Computer tab/i),
    ).toBeInTheDocument();
  });
});

describe("ComputerTab", () => {
  it("renders the Personal computer attach toggle, off by default", () => {
    render(
      <ComputerTab draft={emptyHostConfigInputV2()} onDraftChange={vi.fn()} />,
    );
    const toggle = screen.getByRole("switch", { name: "Personal computer" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it("reflects an attached computer as checked", () => {
    const draft = {
      ...emptyHostConfigInputV2(),
      computer: { kind: "personal" as const },
    };
    render(<ComputerTab draft={draft} onDraftChange={vi.fn()} />);
    expect(
      screen.getByRole("switch", { name: "Personal computer" }),
    ).toBeChecked();
  });
});

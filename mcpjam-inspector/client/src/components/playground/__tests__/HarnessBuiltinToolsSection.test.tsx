import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HarnessBuiltinToolsSection } from "../HarnessBuiltinToolsSection";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

const bash: HarnessBuiltinToolInfo = {
  key: "bash",
  name: "Bash",
  description: "Execute a shell command",
  toolUseKind: "bash",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: { command: { type: "string" } },
  },
};
const grep: HarnessBuiltinToolInfo = {
  key: "grep",
  name: "Grep",
  description: "Search file contents",
};

describe("HarnessBuiltinToolsSection — selectable list", () => {
  it("renders the section + rows and selects a tool by key on click", () => {
    const onSelect = vi.fn();
    render(
      <HarnessBuiltinToolsSection
        tools={[bash, grep]}
        searchQuery=""
        selectedKey={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("Built-in tools")).toBeInTheDocument();
    expect(screen.getByText("runs in sandbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Bash/i }));
    expect(onSelect).toHaveBeenCalledWith("bash");
  });

  it("highlights the selected row", () => {
    render(
      <HarnessBuiltinToolsSection
        tools={[bash, grep]}
        searchQuery=""
        selectedKey="bash"
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Bash/i }).className,
    ).toContain("bg-primary/10");
    expect(
      screen.getByRole("button", { name: /Grep/i }).className,
    ).not.toContain("bg-primary/10");
  });

  it("filters rows with the shared search box", () => {
    render(
      <HarnessBuiltinToolsSection
        tools={[bash, grep]}
        searchQuery="grep"
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Grep")).toBeInTheDocument();
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no built-in tools", () => {
    const { container } = render(
      <HarnessBuiltinToolsSection
        tools={[]}
        searchQuery=""
        selectedKey={null}
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

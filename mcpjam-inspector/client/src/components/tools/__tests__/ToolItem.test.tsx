import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolItem } from "../ToolItem";
import type { Tool } from "@modelcontextprotocol/client";

describe("ToolItem", () => {
  const createTool = (overrides: Partial<Tool> = {}): Tool => ({
    name: "test-tool",
    description: "A test tool description",
    inputSchema: {
      type: "object",
      properties: {},
    },
    ...overrides,
  });

  describe("rendering", () => {
    it("renders tool name", () => {
      const tool = createTool();
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText("test-tool")).toBeInTheDocument();
    });

    it("renders tool description when provided", () => {
      const tool = createTool({ description: "Custom description" });
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText("Custom description")).toBeInTheDocument();
    });

    it("does not render description when not provided", () => {
      const tool = createTool({ description: undefined });
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.queryByText(/description/i)).not.toBeInTheDocument();
    });

    it("displays the name prop, not tool.name", () => {
      const tool = createTool({ name: "internal-name" });
      render(
        <ToolItem
          tool={tool}
          name="display-name"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText("display-name")).toBeInTheDocument();
      expect(screen.queryByText("internal-name")).not.toBeInTheDocument();
    });
  });

  describe("selection state", () => {
    it("applies selected styles when isSelected is true", () => {
      const tool = createTool();
      const { container } = render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={true}
          onClick={vi.fn()}
        />
      );

      const toolElement = container.firstChild as HTMLElement;
      expect(toolElement.className).toContain("bg-muted/50");
      expect(toolElement.className).toContain("shadow-sm");
      expect(toolElement.className).toContain("border");
    });

    it("does not apply selected styles when isSelected is false", () => {
      const tool = createTool();
      const { container } = render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      const toolElement = container.firstChild as HTMLElement;
      expect(toolElement.className).not.toContain("ring-1");
    });
  });

  describe("click handling", () => {
    it("calls onClick when clicked", () => {
      const tool = createTool();
      const onClick = vi.fn();
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={onClick}
        />
      );

      fireEvent.click(screen.getByText("test-tool"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("calls onClick when clicking anywhere in the item", () => {
      const tool = createTool({ description: "Click me" });
      const onClick = vi.fn();
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={onClick}
        />
      );

      fireEvent.click(screen.getByText("Click me"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("accessibility", () => {
    it("has cursor-pointer class for clickability indication", () => {
      const tool = createTool();
      const { container } = render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      const toolElement = container.firstChild as HTMLElement;
      expect(toolElement.className).toContain("cursor-pointer");
    });
  });

  describe("edge cases", () => {
    it("handles empty description gracefully", () => {
      const tool = createTool({ description: "" });
      render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      // Should render without crashing
      expect(screen.getByText("test-tool")).toBeInTheDocument();
    });

    it("handles long tool names", () => {
      const longName = "a".repeat(100);
      const tool = createTool({ name: longName });
      render(
        <ToolItem
          tool={tool}
          name={longName}
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText(longName)).toBeInTheDocument();
    });

    it("handles special characters in name", () => {
      const specialName = "tool:with/special-chars_v2";
      const tool = createTool({ name: specialName });
      render(
        <ToolItem
          tool={tool}
          name={specialName}
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText(specialName)).toBeInTheDocument();
    });

    it("handles long descriptions with line clamping", () => {
      const longDescription = "This is a very long description ".repeat(20);
      const tool = createTool({ description: longDescription });
      const { container } = render(
        <ToolItem
          tool={tool}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );

      // Description should have line-clamp class
      const descriptionElement = container.querySelector(".line-clamp-2");
      expect(descriptionElement).toBeInTheDocument();
    });
  });

  describe("quality badge", () => {
    const badgeOf = (container: HTMLElement) =>
      container.querySelector(
        '[aria-label*="tool quality"]'
      ) as HTMLElement | null;

    it("renders no badge when no quality is provided", () => {
      const { container } = render(
        <ToolItem
          tool={createTool()}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
        />
      );
      expect(badgeOf(container)).toBeNull();
    });

    it("renders an error-styled badge with the finding count and a tooltip", () => {
      const { container } = render(
        <ToolItem
          tool={createTool()}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
          quality={{
            severity: "error",
            labels: ["inputSchema missing (REQUIRED by MCP)", "no description"],
          }}
        />
      );
      const badge = badgeOf(container);
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("2");
      expect(badge!.className).toContain("text-destructive");
      expect(badge!.getAttribute("title")).toContain("inputSchema missing");
      expect(badge!.getAttribute("title")).toContain("no description");
    });

    it("renders a warn-styled badge for signal-only findings", () => {
      const { container } = render(
        <ToolItem
          tool={createTool()}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
          quality={{ severity: "warn", labels: ["very short description"] }}
        />
      );
      const badge = badgeOf(container);
      expect(badge!.textContent).toBe("1");
      expect(badge!.className).toContain("amber");
    });

    it("renders no badge when the label list is empty", () => {
      const { container } = render(
        <ToolItem
          tool={createTool()}
          name="test-tool"
          isSelected={false}
          onClick={vi.fn()}
          quality={{ severity: "warn", labels: [] }}
        />
      );
      expect(badgeOf(container)).toBeNull();
    });
  });
});

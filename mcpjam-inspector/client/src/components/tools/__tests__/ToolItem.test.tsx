import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolItem } from "../ToolItem";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
});

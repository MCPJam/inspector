import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonEditor } from "../json-editor";
import { buildLineLayouts } from "../json-editor-edit";

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(public readonly callback: ResizeObserverCallback) {
    mockResizeObservers.push(this);
  }
}

let mockResizeObservers: MockResizeObserver[] = [];
const originalResizeObserver = global.ResizeObserver;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

function triggerResizeObservers() {
  act(() => {
    for (const observer of mockResizeObservers) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
  });
}

function setElementDimensions(
  element: Element,
  dimensions: Partial<
    Record<"clientHeight" | "scrollHeight" | "clientWidth" | "scrollWidth", number>
  >,
) {
  for (const [property, value] of Object.entries(dimensions)) {
    Object.defineProperty(element, property, {
      configurable: true,
      value,
    });
  }
}

function getReadOnlyViewport(container: HTMLElement): HTMLDivElement | null {
  return container.querySelector(
    "div.relative.z-10.flex.min-w-0.items-start",
  ) as HTMLDivElement | null;
}

function getReadOnlyContentViewport(
  container: HTMLElement,
): HTMLDivElement | null {
  const pre = container.querySelector("pre");
  return (pre?.parentElement as HTMLDivElement | null) ?? null;
}

describe("JsonEditor", () => {
  beforeEach(() => {
    mockResizeObservers = [];
    global.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    global.ResizeObserver = originalResizeObserver;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  describe("autoFormatOnEdit", () => {
    it("formats valid raw content when entering edit mode", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      expect(onRawChange).not.toHaveBeenCalled();

      rerender(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="edit"
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
      });
    });

    it("does not format invalid raw content when entering edit mode", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          height="100%"
          rawContent="{invalid"
          onRawChange={onRawChange}
          mode="view"
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          height="100%"
          rawContent="{invalid"
          onRawChange={onRawChange}
          mode="edit"
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).not.toHaveBeenCalled();
      });
    });

    it("can disable auto formatting on edit", async () => {
      const onRawChange = vi.fn();

      const { rerender } = render(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="view"
          autoFormatOnEdit={false}
          showToolbar={false}
        />,
      );

      rerender(
        <JsonEditor
          height="100%"
          rawContent='{"a":1}'
          onRawChange={onRawChange}
          mode="edit"
          autoFormatOnEdit={false}
          showToolbar={false}
        />,
      );

      await waitFor(() => {
        expect(onRawChange).not.toHaveBeenCalled();
      });
    });
  });

  describe("wrapLongLinesInEdit", () => {
    it("enables soft wrapping in edit mode when configured", () => {
      render(
        <JsonEditor
          height="100%"
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
          wrapLongLinesInEdit={true}
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("soft");
    });

    it("keeps wrapping disabled by default", () => {
      render(
        <JsonEditor
          height="100%"
          rawContent='{"text":"long long long long long long"}'
          mode="edit"
          showToolbar={false}
        />,
      );

      const textarea = screen.getByRole("textbox");
      expect(textarea.getAttribute("wrap")).toBe("off");
    });
  });

  describe("expandJsonStrings", () => {
    it("expands stringified JSON in viewOnly mode", () => {
      render(
        <JsonEditor
          value={{ toolInput: { elements: '[{"type":"ellipse","x":10}]' } }}
          viewOnly
          collapsible
          expandJsonStrings
        />,
      );

      expect(screen.getByText('"elements"')).toBeDefined();
      expect(screen.getByText('"type"')).toBeDefined();
      expect(screen.getByText("10")).toBeDefined();
    });
  });

  describe("readOnly line wrapping", () => {
    it("wraps long lines by default in view-only mode", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
        />,
      );

      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("whitespace-pre-wrap");
      expect(pre?.className).toContain("break-words");
    });

    it("uses a shared vertical scroll container in view-only mode", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
        />,
      );

      const viewport = container.querySelector(
        ".relative.z-10.flex.min-w-0.items-start",
      );
      expect(viewport).toBeTruthy();
      expect(viewport?.className).toContain("items-start");
      expect(viewport?.className).toContain("z-10");

      const gutter = container.querySelector(
        ".self-stretch.flex-shrink-0.text-right.select-none",
      );
      expect(gutter?.className).toContain("self-stretch");

      const fixedGutterBackground = container.querySelector(
        ".absolute.inset-y-0.left-0.w-12.bg-muted\\/50.border-r.border-border\\/50",
      );
      expect(fixedGutterBackground).toBeTruthy();

      const pre = container.querySelector("pre");
      expect(pre?.className).not.toContain("overflow-auto");
    });

    it("can disable wrapping in view-only mode", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
          wrapLongLinesInView={false}
        />,
      );

      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("whitespace-pre");
      expect(pre?.className).not.toContain("whitespace-pre-wrap");
    });

    it("accounts for wrapped lines when calculating line number heights", () => {
      const layouts = buildLineLayouts(
        [
          "{",
          `  "avatarUrl": "${"a".repeat(120)}",`,
          '  "status": "Offline"',
          "}",
        ],
        true,
        40,
      );

      expect(layouts[1]?.height).toBeGreaterThan(20);
      expect(layouts[2]?.top).toBe(
        (layouts[0]?.height ?? 0) + (layouts[1]?.height ?? 0),
      );
    });
  });

  describe("overflow detection", () => {
    it("hides vertical overflow in flat read-only view when content fits", () => {
      const { container } = render(
        <JsonEditor value={{ readOnlyHint: true }} viewOnly showLineNumbers={false} />,
      );

      const viewport = getReadOnlyViewport(container);
      const contentViewport = getReadOnlyContentViewport(container);
      expect(viewport).toBeTruthy();
      expect(contentViewport).toBeTruthy();

      setElementDimensions(viewport!, {
        clientHeight: 100,
        scrollHeight: 100,
      });
      setElementDimensions(contentViewport!, {
        clientWidth: 200,
        scrollWidth: 200,
      });

      triggerResizeObservers();

      expect(viewport).toHaveClass("overflow-y-hidden");
      expect(viewport).toHaveClass("overflow-x-hidden");
      expect(contentViewport).toHaveClass("overflow-x-hidden");
      expect(contentViewport).toHaveClass("overflow-y-hidden");
    });

    it("enables vertical overflow in flat read-only view when content exceeds the container", () => {
      const { container } = render(
        <JsonEditor
          value={{ nested: { readOnlyHint: true, details: "overflow" } }}
          viewOnly
          showLineNumbers={false}
        />,
      );

      const viewport = getReadOnlyViewport(container);
      expect(viewport).toBeTruthy();

      setElementDimensions(viewport!, {
        clientHeight: 100,
        scrollHeight: 220,
      });

      triggerResizeObservers();

      expect(viewport).toHaveClass("overflow-y-auto");
      expect(viewport).toHaveClass("overflow-x-hidden");
    });

    it("remeasures flat read-only view on rerender without a resize event", async () => {
      const { container, rerender } = render(
        <JsonEditor value={{ readOnlyHint: true }} viewOnly showLineNumbers={false} />,
      );

      const viewport = getReadOnlyViewport(container);
      expect(viewport).toBeTruthy();

      setElementDimensions(viewport!, {
        clientHeight: 100,
        scrollHeight: 100,
      });

      triggerResizeObservers();
      expect(viewport).toHaveClass("overflow-y-hidden");

      setElementDimensions(viewport!, {
        clientHeight: 100,
        scrollHeight: 220,
      });

      rerender(
        <JsonEditor
          value={{ readOnlyHint: true, details: { nested: "overflow" } }}
          viewOnly
          showLineNumbers={false}
        />,
      );

      await waitFor(() => {
        expect(viewport).toHaveClass("overflow-y-auto");
      });
    });

    it("enables horizontal overflow in flat read-only view when wrapping is disabled", () => {
      const { container } = render(
        <JsonEditor
          value={{ avatarUrl: `https://${"a".repeat(120)}` }}
          viewOnly
          showLineNumbers={false}
          wrapLongLinesInView={false}
        />,
      );

      const contentViewport = getReadOnlyContentViewport(container);
      expect(contentViewport).toBeTruthy();

      setElementDimensions(contentViewport!, {
        clientWidth: 120,
        scrollWidth: 280,
      });

      triggerResizeObservers();

      expect(contentViewport).toHaveClass("overflow-x-auto");
      expect(contentViewport).toHaveClass("overflow-y-hidden");
    });

    it("preserves horizontal scrolling in tree view when only width overflows", () => {
      const { container } = render(
        <JsonEditor
          value={{ long: "x".repeat(256) }}
          viewOnly
          collapsible
          collapseStringsAfterLength={undefined}
        />,
      );

      const treeRoot = container.querySelector('div[style*="var(--font-code)"]');
      expect(treeRoot).toBeTruthy();

      setElementDimensions(treeRoot!, {
        clientHeight: 100,
        scrollHeight: 100,
        clientWidth: 120,
        scrollWidth: 280,
      });

      triggerResizeObservers();

      expect(treeRoot).toHaveClass("overflow-x-auto");
      expect(treeRoot).toHaveClass("overflow-y-hidden");
    });

    it("hides both axes in tree view when content fits", () => {
      const { container } = render(
        <JsonEditor value={{ readOnlyHint: true }} viewOnly collapsible />,
      );

      const treeRoot = container.querySelector('div[style*="var(--font-code)"]');
      expect(treeRoot).toBeTruthy();

      setElementDimensions(treeRoot!, {
        clientHeight: 100,
        scrollHeight: 100,
        clientWidth: 200,
        scrollWidth: 200,
      });

      triggerResizeObservers();

      expect(treeRoot).toHaveClass("overflow-x-hidden");
      expect(treeRoot).toHaveClass("overflow-y-hidden");
    });
  });
});

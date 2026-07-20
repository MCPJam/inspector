import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProductUpdateExpandedPanel } from "../ProductUpdateExpandedPanel";
import type { ProductUpdateEntry } from "../productUpdateEntry";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }
  >(function MotionDiv(
    {
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    },
    ref
  ) {
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    );
  });

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    motion: { div: MotionDiv },
  };
});

function update(
  overrides: Partial<ProductUpdateEntry> = {}
): ProductUpdateEntry {
  return {
    slug: "test-update",
    publishAt: Date.UTC(2026, 6, 17),
    title: "Test update",
    body: "Body",
    previewVideoUrl: "https://videos.example/test.mp4",
    dismissed: false,
    isNew: true,
    ...overrides,
  };
}

describe("ProductUpdateExpandedPanel", () => {
  it("hides native controls only when the update requests it", () => {
    const { container, rerender } = render(
      <ProductUpdateExpandedPanel
        entry={update({ hideControls: true })}
        sourceRect={null}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector("video")).not.toHaveAttribute("controls");

    rerender(
      <ProductUpdateExpandedPanel
        entry={update()}
        sourceRect={null}
        onClose={vi.fn()}
      />
    );

    expect(container.querySelector("video")).toHaveAttribute("controls");
  });
});

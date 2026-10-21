/**
 * The `tooltip` variant lets a hover card stand in for a tooltip: its header
 * must paint the same pill as TooltipContent, and the default `card` variant
 * must keep rendering exactly what every existing hover card renders today.
 */
// @vitest-environment jsdom
//
// Per FILE: this package's `tokens-parity` test reads `tokens.css` through
// `import.meta.url`, which jsdom turns into http: and `readFileSync` rejects.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Badge } from "../components/badge";
import {
  HoverCard,
  HoverCardBody,
  HoverCardContent,
  HoverCardHeader,
  HoverCardTrigger,
} from "../components/hover-card";
import { tooltipPillClassName } from "../components/tooltip";

// The package has no setup file and no `globals`, so Testing Library cannot
// register its own auto-cleanup. Do it explicitly.
afterEach(cleanup);

// Radix measures the arrow with ResizeObserver, which jsdom lacks. Sizes
// don't matter here: only which classes and parts render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

function openCard(content: React.ReactNode) {
  render(
    <HoverCard open>
      <HoverCardTrigger asChild>
        <button type="button">Trigger</button>
      </HoverCardTrigger>
      {content}
    </HoverCard>,
  );
  return document.querySelector(
    "[data-slot='hover-card-content']",
  ) as HTMLElement;
}

describe("HoverCardContent", () => {
  it("keeps today's card surface by default, with no arrow", () => {
    const content = openCard(<HoverCardContent>Body</HoverCardContent>);

    for (const cls of [
      "bg-popover",
      "text-popover-foreground",
      "w-64",
      "rounded-md",
      "border",
      "p-4",
      "shadow-md",
    ]) {
      expect(content).toHaveClass(cls);
    }
    expect(content).toHaveAttribute("data-variant", "card");
    expect(content.querySelector("svg")).toBeNull();
  });

  it("draws no surface of its own and adds the arrow in the tooltip variant", () => {
    const content = openCard(
      <HoverCardContent variant="tooltip">
        <HoverCardHeader>Servers</HoverCardHeader>
      </HoverCardContent>,
    );

    expect(content).toHaveAttribute("data-variant", "tooltip");
    expect(content).not.toHaveClass("bg-popover");
    expect(content).not.toHaveClass("p-4");
    expect(content.querySelector("svg")).not.toBeNull();
  });
});

describe("HoverCardHeader", () => {
  it("paints the tooltip pill", () => {
    openCard(
      <HoverCardContent variant="tooltip">
        <HoverCardHeader>Servers</HoverCardHeader>
      </HoverCardContent>,
    );

    const header = screen.getByText("Servers");
    for (const cls of tooltipPillClassName.split(" ")) {
      expect(header).toHaveClass(cls);
    }
  });

  it("squares its bottom corners only when a body follows", () => {
    openCard(
      <HoverCardContent variant="tooltip">
        <HoverCardHeader>Playground</HoverCardHeader>
        <HoverCardBody>Clip</HoverCardBody>
      </HoverCardContent>,
    );

    // jsdom has no layout, so the selector the header carries is what's
    // observable; `:has(+body)` is what makes it conditional in a browser.
    expect(screen.getByText("Playground").className).toContain(
      "[&:has(+[data-slot=hover-card-body])]:rounded-b-none",
    );
    expect(screen.getByText("Clip")).toHaveAttribute(
      "data-slot",
      "hover-card-body",
    );
  });
});

describe("Badge inverse variant", () => {
  it("swaps the primary pair so it reads on a primary fill", () => {
    render(<Badge variant="inverse">New</Badge>);

    const badge = screen.getByText("New");
    expect(badge).toHaveClass("bg-primary-foreground", "text-primary");
    expect(badge).not.toHaveClass("bg-primary");
  });

  it("leaves the default badge unchanged", () => {
    render(<Badge>New</Badge>);

    expect(screen.getByText("New")).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
    );
  });
});

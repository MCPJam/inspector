import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoizedMarkdown } from "../memomized-markdown";

// Stand-in for Streamdown: keeps the remark/mermaid/shiki graph out of jsdom,
// and gives the boundary test a deterministic way to throw mid-render.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => {
    if (children.includes("THROW_ON_RENDER")) {
      throw new RangeError("Maximum call stack size exceeded");
    }
    return <div data-testid="streamdown">{children}</div>;
  },
  defaultUrlTransform: (url: string) => url,
}));

// INSPECTOR-CLIENT-253: ~2KB of nesting exhausts the stack in marked's lexer.
const pathologicallyNested = `- x\n  ${">".repeat(2500)} deep`;

describe("MemoizedMarkdown", () => {
  it("splits ordinary markdown into Streamdown blocks", () => {
    render(<MemoizedMarkdown content={"# Title\n\nA paragraph.\n"} />);

    const blocks = screen.getAllByTestId("streamdown");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.textContent).join("")).toContain("A paragraph.");
  });

  it("still renders markdown at ordinary nesting depth", () => {
    render(<MemoizedMarkdown content={"> > > quoted three deep\n"} />);

    expect(screen.getAllByTestId("streamdown").length).toBeGreaterThan(0);
  });

  it("renders pathologically nested markdown as plain text instead of crashing", () => {
    expect(() =>
      render(<MemoizedMarkdown content={pathologicallyNested} />),
    ).not.toThrow();

    // Plain text, not markdown: Streamdown recurses per nesting level too.
    expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-plain-text")).toHaveTextContent("deep");
  });

  it("falls back to the raw text when the markdown renderer throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(() =>
      render(<MemoizedMarkdown content="THROW_ON_RENDER please" />),
    ).not.toThrow();
    expect(screen.getByTestId("markdown-plain-text")).toHaveTextContent(
      "THROW_ON_RENDER please",
    );

    consoleError.mockRestore();
  });
});

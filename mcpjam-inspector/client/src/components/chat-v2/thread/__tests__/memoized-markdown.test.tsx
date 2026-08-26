import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// `vi.hoisted`: the static import above makes this factory run during
// collection, before a plain `const` would be initialized.
const { lexerCalls } = vi.hoisted(() => ({ lexerCalls: vi.fn() }));

// Real lexer, plus a call counter and one sentinel that exercises the `catch`.
vi.mock("marked", async () => {
  const actual = await vi.importActual<typeof import("marked")>("marked");
  return {
    marked: {
      ...actual.marked,
      lexer: (markdown: string) => {
        lexerCalls(markdown);
        if (markdown.includes("LEXER_THROWS")) {
          throw new RangeError("Maximum call stack size exceeded");
        }
        return actual.marked.lexer(markdown);
      },
    },
  };
});

// INSPECTOR-CLIENT-253: ~2KB of nesting exhausts the stack in marked's lexer.
const pathologicallyNested = `- x\n  ${">".repeat(2500)} deep`;

describe("MemoizedMarkdown", () => {
  beforeEach(() => {
    lexerCalls.mockClear();
  });

  it("blocks inline emphasis runs before they reach the lexer", () => {
    // No indentation and no `>` markers, so the block-nesting scan scored this
    // 0 and handed 10KB straight to marked, which overflows on it.
    const run = "*".repeat(5000);
    render(<MemoizedMarkdown content={`${run}x${run}`} />);

    expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-plain-text")).toBeInTheDocument();
    // Caught by the deterministic scan, not by the `try/catch` behind it.
    expect(lexerCalls).not.toHaveBeenCalled();
  });

  it("stops re-lexing once a parse has failed mid-stream", () => {
    // `useMemo` is keyed on the whole content, which grows every streaming
    // tick; without the latch each tick re-enters the lexer and re-throws.
    const { rerender } = render(<MemoizedMarkdown content="LEXER_THROWS a" />);
    const callsAfterFirstTick = lexerCalls.mock.calls.length;

    rerender(<MemoizedMarkdown content="LEXER_THROWS ab" />);
    rerender(<MemoizedMarkdown content="LEXER_THROWS abc" />);

    expect(lexerCalls.mock.calls.length).toBe(callsAfterFirstTick);
    expect(screen.getByTestId("markdown-plain-text")).toHaveTextContent(
      "LEXER_THROWS abc",
    );
  });

  it("gives a different document a fresh attempt after a failed parse", () => {
    // SkillFileViewer mounts MemoizedMarkdown with no key, so switching file
    // reuses this instance. The latch must not outlive the content it fired on.
    const { rerender } = render(<MemoizedMarkdown content="LEXER_THROWS a" />);
    expect(screen.getByTestId("markdown-plain-text")).toBeInTheDocument();

    rerender(<MemoizedMarkdown content={"# Another file\n\nFine.\n"} />);

    expect(screen.getAllByTestId("streamdown").length).toBeGreaterThan(0);
  });

  it("gives a different document a fresh attempt after a renderer throw", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { rerender } = render(
      <MemoizedMarkdown content="THROW_ON_RENDER a" />,
    );
    expect(screen.getByTestId("markdown-plain-text")).toBeInTheDocument();

    rerender(<MemoizedMarkdown content={"# Another file\n\nFine.\n"} />);

    expect(screen.getAllByTestId("streamdown").length).toBeGreaterThan(0);
    consoleError.mockRestore();
  });

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

  it("counts two-space list indentation at marked's own granularity", () => {
    // 202 levels of the tightest nesting marked recognises must exceed the
    // cap; counting indentation any coarser would let it through.
    const nestedList = Array.from(
      { length: 202 },
      (_, level) => `${" ".repeat(level * 2)}- x`,
    ).join("\n");

    render(<MemoizedMarkdown content={nestedList} />);

    expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-plain-text")).toBeInTheDocument();
  });

  it("renders content past the size cap as plain text", () => {
    // One character over MAX_MARKDOWN_CHARS.
    render(<MemoizedMarkdown content={"a".repeat(512_001)} />);

    expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-plain-text")).toBeInTheDocument();
  });

  it("renders plain text when the lexer itself throws", () => {
    // The `catch` in parseMarkdownIntoBlocks, not the boundary — so nothing
    // should reach console.error here.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(<MemoizedMarkdown content="LEXER_THROWS here" />);

    expect(screen.queryByTestId("streamdown")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-plain-text")).toHaveTextContent(
      "LEXER_THROWS here",
    );
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
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

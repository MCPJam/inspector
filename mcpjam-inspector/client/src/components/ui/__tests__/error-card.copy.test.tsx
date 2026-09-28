import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";
import { copyToClipboard } from "@/lib/clipboard";
import { ErrorCard } from "../error-card";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const copyMock = vi.mocked(copyToClipboard);

function normalized(): NormalizedError {
  return {
    ...describeAsSlug(
      "transport/econnrefused",
      new Error("connect ECONNREFUSED 127.0.0.1:3000"),
    ),
    rawCode: "ECONNREFUSED",
    cause: { name: "AggregateError", message: "all sockets refused" },
  };
}

function copyButton() {
  return screen.getByTestId("error-card-copy");
}

describe("ErrorCard copy", () => {
  beforeEach(() => {
    copyMock.mockClear();
    copyMock.mockResolvedValue(true);
  });

  it("copies a block carrying everything the card renders", async () => {
    const error = normalized();
    render(<ErrorCard error={error} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    const text = copyMock.mock.calls[0][0];
    expect(text).toContain(error.title);
    expect(text).toContain(error.oneLine);
    for (const cause of error.likelyCauses) expect(text).toContain(cause);
    for (const step of error.nextSteps) expect(text).toContain(step);
    expect(text).toContain(error.rawMessage);
    expect(text).toContain("code: ECONNREFUSED");
    expect(text).toContain("AggregateError: all sockets refused");
  });

  it("copies the details even while they are collapsed", async () => {
    // The whole point is pasting to an agent — making the user expand the
    // disclosure first would defeat it.
    const error = normalized();
    render(<ErrorCard error={error} />);

    expect(screen.queryByText(error.rawMessage)).not.toBeInTheDocument();
    fireEvent.click(copyButton());

    await waitFor(() => expect(copyMock).toHaveBeenCalledTimes(1));
    expect(copyMock.mock.calls[0][0]).toContain(error.rawMessage);
  });

  it("confirms a copy that landed", async () => {
    render(<ErrorCard error={normalized()} />);

    fireEvent.click(copyButton());

    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("says so when the clipboard refused instead of claiming success", async () => {
    // `copyToClipboard` REPORTS failure by returning false rather than
    // throwing, so a card that ignores the result lies to the user.
    copyMock.mockResolvedValue(false);
    render(<ErrorCard error={normalized()} />);

    fireEvent.click(copyButton());

    expect(await screen.findByText("Copy failed")).toBeInTheDocument();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("keeps a surrounding drag surface from stealing the gesture", () => {
    // dnd-kit spreads its sortable listeners over the whole server card, and
    // once the drag activates it wipes the selection on every selectionchange.
    const onPointerDown = vi.fn();
    const error = normalized();
    render(
      <div onPointerDown={onPointerDown}>
        <ErrorCard error={error} />
      </div>,
    );

    fireEvent.pointerDown(screen.getByText(error.oneLine));

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("opts out of the node styles that block selection inside a canvas", () => {
    // `.react-flow__node` sets `user-select: none` and a mousedown on a node
    // pans the viewport unless the target opts out.
    render(<ErrorCard error={normalized()} />);

    const card = screen.getByRole("alert");
    expect(card).toHaveClass("select-text");
    expect(card).toHaveClass("nodrag");
    expect(card).toHaveClass("nopan");
  });
});

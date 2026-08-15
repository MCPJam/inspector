import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TurnRating } from "../turn-rating";

describe("TurnRating", () => {
  it("exposes five stars as a radiogroup", () => {
    render(<TurnRating />);
    const group = screen.getByRole("radiogroup");
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
  });

  it("submits the stars on the first click, before any comment is written", () => {
    // A rating that only counts once someone also types is a rating most
    // testers never leave.
    const onSubmit = vi.fn();
    render(<TurnRating onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "3 of 5" }));

    expect(onSubmit).toHaveBeenCalledWith({ value: 3 });
  });

  it("opens the comment row after the first star and submits it separately", () => {
    const onSubmit = vi.fn();
    render(<TurnRating onSubmit={onSubmit} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "2 of 5" }));

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "lost my order" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenLastCalledWith({
      value: 2,
      comment: "lost my order",
    });
  });

  it("marks the stored rating as checked", () => {
    render(<TurnRating value={4} status="submitted" />);
    expect(screen.getByRole("radio", { name: "4 of 5" })).toBeChecked();
  });

  it("stays re-ratable after submitting", () => {
    // `submitted` is a resting state, not a terminal one — a tester revising a
    // rating is the whole reason the backend upserts instead of appending.
    const onSubmit = vi.fn();
    render(<TurnRating value={2} status="submitted" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "5 of 5" }));

    expect(onSubmit).toHaveBeenCalledWith({ value: 5 });
  });

  it("blocks input while a submission is pending", () => {
    const onSubmit = vi.fn();
    render(<TurnRating value={3} status="pending" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "1 of 5" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces an error state instead of claiming the rating saved", () => {
    render(<TurnRating value={3} status="error" />);
    expect(screen.getByText(/could not save/i)).toBeInTheDocument();
  });

  it("read-only mode shows the comment and takes no input", () => {
    const onSubmit = vi.fn();
    render(
      <TurnRating
        readOnly
        value={1}
        comment="it never found my order"
        status="submitted"
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByText(/it never found my order/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "4 of 5" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("carries the existing comment when only the stars change", () => {
    // Re-rating an annotated turn must not read as "they removed the comment".
    // The mutation would keep it (an omitted comment means "leave it alone"),
    // but the host's optimistic state would blank it on screen until the next
    // round-trip.
    const onSubmit = vi.fn();
    render(
      <TurnRating
        value={2}
        comment="lost my order"
        status="submitted"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "4 of 5" }));

    expect(onSubmit).toHaveBeenCalledWith({
      value: 4,
      comment: "lost my order",
    });
  });

  it("omits the comment entirely when there is none to carry", () => {
    const onSubmit = vi.fn();
    render(<TurnRating onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("radio", { name: "4 of 5" }));
    expect(onSubmit).toHaveBeenCalledWith({ value: 4 });
  });

  it("does not publish an unsent draft when the stars change", () => {
    // Typing is not submitting. Changing your mind about the stars is not
    // consent to send text you were still writing — the draft stays in the
    // editor for the explicit Send.
    const onSubmit = vi.fn();
    render(<TurnRating onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "2 of 5" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "half-written thought" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "3 of 5" }));

    expect(onSubmit).toHaveBeenLastCalledWith({ value: 3 });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "half-written thought"
    );
  });

  it("keeps the editor and the draft open when a comment save fails", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<TurnRating onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "2 of 5" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "lost my order" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    rerender(<TurnRating status="error" onSubmit={onSubmit} />);

    // The draft survives and the Send button is still there to retry with.
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("lost my order");
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("collapses the editor once the comment save lands", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<TurnRating onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "5 of 5" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "great" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    rerender(<TurnRating value={5} status="submitted" onSubmit={onSubmit} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("does not collapse the editor when a star click resolves", () => {
    // A star click also reaches `submitted`; only a comment save should close
    // the row someone may be about to type in.
    const onSubmit = vi.fn();
    const { rerender } = render(<TurnRating onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("radio", { name: "3 of 5" }));
    rerender(<TurnRating value={3} status="submitted" onSubmit={onSubmit} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("adopts a rating the host rehydrates after mount", () => {
    const { rerender } = render(<TurnRating />);
    expect(screen.getByRole("radio", { name: "5 of 5" })).not.toBeChecked();

    rerender(<TurnRating value={5} status="submitted" />);
    expect(screen.getByRole("radio", { name: "5 of 5" })).toBeChecked();
  });
});

describe("TurnRating — thumbs variant", () => {
  it("renders two thumbs as a radiogroup", () => {
    render(<TurnRating variant="thumbs" />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(
      screen.getByRole("radio", { name: "Thumbs up" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Thumbs down" })
    ).toBeInTheDocument();
  });

  it("submits 1 for up and 0 for down — the numeric contract is unchanged", () => {
    const onSubmit = vi.fn();
    const { unmount } = render(
      <TurnRating variant="thumbs" onSubmit={onSubmit} />
    );
    fireEvent.click(screen.getByRole("radio", { name: "Thumbs up" }));
    expect(onSubmit).toHaveBeenCalledWith({ value: 1 });

    unmount();
    onSubmit.mockClear();
    render(<TurnRating variant="thumbs" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("radio", { name: "Thumbs down" }));
    expect(onSubmit).toHaveBeenCalledWith({ value: 0 });
  });

  it("opens the comment row on the first thumb, like stars", () => {
    const onSubmit = vi.fn();
    render(<TurnRating variant="thumbs" onSubmit={onSubmit} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Thumbs down" }));

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "made something up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenLastCalledWith({
      value: 0,
      comment: "made something up",
    });
  });

  it("distinguishes a stored thumbs-down from nothing rated at all", () => {
    // The `draftValue === undefined` sentinel earning its keep: 0 is a real
    // judgement, and a falsy check anywhere in here would render it unrated.
    const { rerender } = render(<TurnRating variant="thumbs" />);
    expect(
      screen.getByRole("radio", { name: "Thumbs down" })
    ).not.toBeChecked();

    rerender(<TurnRating variant="thumbs" value={0} status="submitted" />);
    expect(screen.getByRole("radio", { name: "Thumbs down" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Thumbs up" })).not.toBeChecked();
  });

  it("re-clicking the other thumb switches the judgement", () => {
    const onSubmit = vi.fn();
    render(
      <TurnRating
        variant="thumbs"
        value={0}
        status="submitted"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Thumbs up" }));

    expect(onSubmit).toHaveBeenCalledWith({ value: 1 });
    expect(screen.getByRole("radio", { name: "Thumbs up" })).toBeChecked();
  });

  it("blocks input while a submission is pending", () => {
    const onSubmit = vi.fn();
    render(
      <TurnRating
        variant="thumbs"
        value={1}
        status="pending"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("radio", { name: "Thumbs down" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders read-only with the comment and no inputs", () => {
    const onSubmit = vi.fn();
    render(
      <TurnRating
        variant="thumbs"
        readOnly
        value={0}
        comment="wrong order"
        status="submitted"
        onSubmit={onSubmit}
      />
    );

    expect(screen.getByRole("radio", { name: "Thumbs down" })).toBeChecked();
    expect(screen.getByText(/wrong order/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Thumbs up" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

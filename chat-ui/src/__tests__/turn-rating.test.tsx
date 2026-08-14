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

  it("adopts a rating the host rehydrates after mount", () => {
    const { rerender } = render(<TurnRating />);
    expect(screen.getByRole("radio", { name: "5 of 5" })).not.toBeChecked();

    rerender(<TurnRating value={5} status="submitted" />);
    expect(screen.getByRole("radio", { name: "5 of 5" })).toBeChecked();
  });
});

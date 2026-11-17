import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CREATE_SUITE_FORM_ANCHOR, TourHandoff } from "../tour-handoff";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => true };
});

function Pane({
  form,
  onDismiss,
}: {
  form: boolean;
  onDismiss: (reason: string) => void;
}) {
  return (
    <div>
      {form ? <form data-tour-anchor={CREATE_SUITE_FORM_ANCHOR} /> : null}
      <TourHandoff onDismiss={onDismiss} />
    </div>
  );
}

describe("TourHandoff", () => {
  it("covers the pane until the create-suite form renders", async () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Pane form={false} onDismiss={onDismiss} />);
    expect(
      screen.getByTestId("evaluate-tour-handoff-cover"),
    ).toBeInTheDocument();

    rerender(<Pane form onDismiss={onDismiss} />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("evaluate-tour-handoff-cover"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("guided-tour-coachmark")).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each([
    ["got_it", () => fireEvent.click(screen.getByRole("button"))],
    ["escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["clicked_away", () => fireEvent.pointerDown(document.body)],
  ])("reports %s as how the note closed", async (reason, close) => {
    const onDismiss = vi.fn();
    render(<Pane form onDismiss={onDismiss} />);
    await screen.findByTestId("guided-tour-coachmark");

    close();

    expect(onDismiss).toHaveBeenCalledWith(reason);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CREATE_SUITE_FORM_ANCHOR, TourHandoff } from "../tour-handoff";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => true };
});

function Pane({ form, onDismiss }: { form: boolean; onDismiss: () => void }) {
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
    expect(screen.getByTestId("evaluate-tour-popover")).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

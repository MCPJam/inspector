import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiModelMissingColumnsNotice } from "../multi-model-column-notice";

describe("MultiModelMissingColumnsNotice", () => {
  it("names each missing column and opens it alone", () => {
    const openModel = vi.fn();
    const openClient = vi.fn();
    render(
      <MultiModelMissingColumnsNotice
        columns={[
          { id: "model:a", label: "GPT-6", reason: "model", open: openModel },
          { id: "host:h", label: "Cursor", reason: "client", open: openClient },
        ]}
      />,
    );
    expect(
      screen.getByText(
        "GPT-6 isn't available anymore, so its column didn't reopen.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Cursor's client isn't in this project anymore, so its column didn't reopen. Open it alone, or pick another client.",
      ),
    ).toBeTruthy();
    const [first, second] = screen.getAllByRole("button", {
      name: "Open it alone",
    });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(openModel).toHaveBeenCalledTimes(1);
    expect(openClient).toHaveBeenCalledTimes(1);
  });
});

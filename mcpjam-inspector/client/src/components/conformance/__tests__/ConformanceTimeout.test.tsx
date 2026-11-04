import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { ConformanceTimeout } from "../ConformanceTimeout";

function setup(
  seconds?: number,
  onSave = vi.fn(async (_value: number | null) => {}),
) {
  render(
    <TooltipProvider>
      <ConformanceTimeout seconds={seconds} onSave={onSave} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Run timeout" }));
  return {
    onSave,
    input: screen.getByLabelText("Total run timeout (seconds)"),
  };
}

describe("ConformanceTimeout", () => {
  it.each([1, 300])("saves %s seconds", async (seconds) => {
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value: String(seconds) } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(seconds));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Total run timeout (seconds)"),
      ).not.toBeInTheDocument(),
    );
  });
  it.each(["0", "301", "1.5", "-1"])("rejects %s", async (value) => {
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a whole number from 1 to 300 seconds.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });
  it("clears a saved timeout", async () => {
    const { input, onSave } = setup(30);
    expect(screen.getByText("30s")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
  it("keeps the draft open after a failed save", async () => {
    const onSave = vi.fn(async (_value: number | null) => {
      throw new Error("offline");
    });
    const { input } = setup(30, onSave);
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the timeout. Try again.",
    );
    expect(input).toHaveValue(90);
  });
});

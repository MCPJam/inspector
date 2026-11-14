import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConformanceTimeoutSetting } from "../ConformanceTimeout";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

const LABEL = "Total run timeout (seconds)";

function setup(
  seconds?: number,
  onSave = vi.fn(async (_value: number | null) => {}),
  onInvalidChange = vi.fn(),
) {
  const view = render(
    <ConformanceTimeoutSetting
      seconds={seconds}
      onSave={onSave}
      onInvalidChange={onInvalidChange}
    />,
  );
  return {
    ...view,
    onSave,
    onInvalidChange,
    input: screen.getByLabelText(LABEL),
  };
}

function commit(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("ConformanceTimeoutSetting", () => {
  it("shows the 300-second default, with no Save button", () => {
    const { input } = setup();
    expect(input).toHaveValue(300);
    expect(
      screen.getByText(
        "Maximum time for the whole run. Defaults to 300 seconds (5 minutes).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a saved override", () => {
    const { input } = setup(45);
    expect(input).toHaveValue(45);
  });

  it.each([1, 90, 300])("saves %s seconds when the field is left", async (seconds) => {
    const { input, onSave } = setup(45);
    commit(input, String(seconds));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(seconds));
  });

  it("saves on Enter", async () => {
    const { input, onSave } = setup();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(90));
  });

  it("does not save a value that did not change", async () => {
    const { input, onSave } = setup();
    commit(input, "300");
    await Promise.resolve();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(["0", "301", "1.5", "-1"])(
    "rejects %s and reports it invalid until it is fixed",
    async (value) => {
      const { input, onSave, onInvalidChange } = setup();
      commit(input, value);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Enter a whole number from 1 to 300 seconds.",
      );
      expect(onSave).not.toHaveBeenCalled();
      expect(onInvalidChange).toHaveBeenLastCalledWith(true);
      commit(input, "60");
      await waitFor(() =>
        expect(onInvalidChange).toHaveBeenLastCalledWith(false),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("rejects text the number field cannot parse instead of clearing the override", async () => {
    // For "3e" or "-" the browser reports the value as "", like a cleared
    // field; only `validity.badInput` says it is malformed.
    const { input, onSave } = setup(45);
    Object.defineProperty(input, "validity", {
      configurable: true,
      value: { badInput: true },
    });
    commit(input, "");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a whole number from 1 to 300 seconds.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not report a save in flight as invalid", async () => {
    // Pressing Back blurs the field and starts this save; reporting it would
    // disable Back before the click lands.
    let finish: () => void = () => {};
    const onSave = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { input, onInvalidChange } = setup(undefined, onSave);
    commit(input, "90");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(90));
    expect(screen.getByText("Saving...")).toBeInTheDocument();
    expect(onInvalidChange).not.toHaveBeenCalledWith(true);
    finish();
  });

  it("drops its error when a newer saved value replaces the field", async () => {
    const { input, rerender, onSave, onInvalidChange } = setup(45);
    commit(input, "0");
    await screen.findByRole("alert");
    // A teammate saves 120.
    rerender(
      <ConformanceTimeoutSetting
        seconds={120}
        onSave={onSave}
        onInvalidChange={onInvalidChange}
      />,
    );
    expect(input).toHaveValue(120);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
  });

  it("clears a saved override back to the default", async () => {
    function Saved() {
      const [seconds, setSeconds] = useState<number | undefined>(30);
      return (
        <ConformanceTimeoutSetting
          seconds={seconds}
          onSave={async (value) => setSeconds(value ?? undefined)}
        />
      );
    }
    render(<Saved />);
    const input = screen.getByLabelText(LABEL);
    expect(input).toHaveValue(30);
    commit(input, "");
    await waitFor(() => expect(input).toHaveValue(300));
  });

  it("compares a change with its own last save before the prop catches up", async () => {
    // A saved run's Settings reads a snapshot that may not move after a save.
    const { input, onSave } = setup();
    commit(input, "90");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(90));
    commit(input, "300");
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(300));
  });

  it("reports a failed save with a toast and keeps what was typed", async () => {
    toastError.mockClear();
    const onSave = vi.fn(async (_value: number | null) => {
      throw new Error("offline");
    });
    const { input } = setup(30, onSave);
    commit(input, "90");
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not save the run timeout. Try again.",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveValue(90);
  });
});

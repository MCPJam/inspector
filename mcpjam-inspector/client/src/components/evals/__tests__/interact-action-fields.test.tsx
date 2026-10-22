import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractActionFields } from "../step-fields";
import type { InteractAction } from "@/shared/steps";

afterEach(cleanup);

const actions: InteractAction[] = [
  {
    kind: "click",
    target: { testId: "generate", nth: 1 },
    clickType: "double",
  },
  { kind: "type", target: { css: "#name" }, text: "Services diagram" },
  { kind: "key", key: "Enter" },
  { kind: "scroll", direction: "down", amount: 200 },
  { kind: "wait", ms: 500 },
];

describe("Paper interaction controls", () => {
  it("edits click options while preserving the recorded target", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[0]!} onChange={onChange} />,
    );
    expect(screen.getByPlaceholderText("testId…")).toHaveValue("generate");
    await user.click(screen.getByRole("combobox", { name: "Click type" }));
    await user.click(
      screen.getByRole("option", { name: "right", exact: true }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...actions[0],
      clickType: "right",
    });
  });

  it("edits typed text while preserving the selector", () => {
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[1]!} onChange={onChange} />,
    );
    expect(screen.getByPlaceholderText(".my-button")).toHaveValue("#name");
    fireEvent.change(screen.getByLabelText("Text to type"), {
      target: { value: "Architecture" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...actions[1],
      text: "Architecture",
    });
  });

  it("edits a key press", () => {
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[2]!} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "Tab" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "key", key: "Tab" });
  });

  it("edits scroll direction and can clear an optional amount", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[3]!} onChange={onChange} />,
    );
    await user.click(screen.getByRole("combobox", { name: "Direction" }));
    await user.click(screen.getByRole("option", { name: "up", exact: true }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...actions[3],
      direction: "up",
    });
    fireEvent.change(screen.getByLabelText("Scroll amount"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...actions[3],
      amount: undefined,
    });
  });

  it("edits wait duration", () => {
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[4]!} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Wait duration"), {
      target: { value: "1000" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "wait", ms: 1000 });
  });

  it.each(actions)(
    "locks a recorded $kind action in a read-only row",
    (action) => {
      const onChange = vi.fn();
      render(
        <fieldset disabled>
          <InteractActionFields
            paper
            readOnly
            value={action}
            onChange={onChange}
          />
        </fieldset>,
      );
      for (const control of screen.getAllByRole("combobox"))
        expect(control).toBeDisabled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps all existing ways to choose a target", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InteractActionFields paper value={actions[0]!} onChange={onChange} />,
    );
    await user.click(
      within(screen.getByRole("group", { name: "Target" })).getByRole(
        "combobox",
      ),
    );
    for (const name of ["testId", "role", "text", "css"]) {
      expect(screen.getByRole("option", { name, exact: true })).toBeVisible();
    }
    await user.click(screen.getByRole("option", { name: "css", exact: true }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...actions[0],
      target: { css: "" },
    });
  });
});

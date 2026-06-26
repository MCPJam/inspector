import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { AddStepPicker, secondaryCount } from "../add-step-picker";

describe("AddStepPicker", () => {
  it("shows actions and check essentials by default, secondary checks on expand", async () => {
    const user = userEvent.setup();

    renderWithProviders(<AddStepPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));

    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Checks")).toBeTruthy();
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Interact")).toBeTruthy();
    expect(screen.getByText("Call tool")).toBeTruthy();
    expect(screen.getByText("Tool was called with…")).toBeTruthy();
    expect(screen.getByText("Response contains…")).toBeTruthy();
    expect(screen.getByText("View rendered")).toBeTruthy();
    expect(screen.queryByText("Tool was called at least once")).toBeNull();
    expect(screen.queryByText("Text visible")).toBeNull();
    expect(screen.getByTestId("add-step-expand-more")).toHaveTextContent(
      `More checks (${secondaryCount()})`,
    );
  });

  it("reveals secondary checks when expanded", async () => {
    const user = userEvent.setup();

    renderWithProviders(<AddStepPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-expand-more"));

    expect(screen.getByText("More conversation checks")).toBeTruthy();
    expect(screen.getByText("Did the view load")).toBeTruthy();
    expect(screen.getByText("What's on screen")).toBeTruthy();
    expect(screen.getByText("Run health")).toBeTruthy();
    expect(screen.getByText("Text visible")).toBeTruthy();
    expect(screen.getByText("No view console errors so far")).toBeTruthy();
    expect(screen.queryByTestId("add-step-expand-more")).toBeNull();
  });

  it("shows secondary checks when defaultMoreExpanded is true", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <AddStepPicker onSelect={vi.fn()} defaultMoreExpanded />,
    );

    await user.click(screen.getByRole("button", { name: /^add/i }));

    expect(screen.getByText("Text visible")).toBeTruthy();
    expect(screen.queryByTestId("add-step-expand-more")).toBeNull();
  });

  it("adds a prompt step when Prompt is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProviders(<AddStepPicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-item-prompt"));

    expect(onSelect).toHaveBeenCalledWith({
      kind: "step",
      stepKind: "prompt",
    });
  });

  it("adds a call-tool step when Call tool is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProviders(<AddStepPicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-item-toolCall"));

    expect(onSelect).toHaveBeenCalledWith({
      kind: "step",
      stepKind: "toolCall",
    });
  });

  it("adds a conversation check when Tool was called with is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProviders(<AddStepPicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-item-check:toolCalledWith"));

    expect(onSelect).toHaveBeenCalledWith({
      kind: "check",
      predicateKind: "toolCalledWith",
    });
  });

  it("finds widget checks via filter without expanding", async () => {
    const user = userEvent.setup();

    renderWithProviders(<AddStepPicker onSelect={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.type(
      screen.getByLabelText(/filter steps and checks/i),
      "input value",
    );

    expect(screen.getByText("Input value equals")).toBeTruthy();
    expect(screen.queryByText("Prompt")).toBeNull();
  });

  it("selects the active item on Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProviders(<AddStepPicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    const search = screen.getByLabelText(/filter steps and checks/i);
    await user.type(search, "prompt{Enter}");

    expect(onSelect).toHaveBeenCalledWith({
      kind: "step",
      stepKind: "prompt",
    });
  });

  it("selects a secondary item via keyboard after expanding", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProviders(<AddStepPicker onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /^add/i }));
    await user.click(screen.getByTestId("add-step-expand-more"));

    const search = screen.getByLabelText(/filter steps and checks/i);
    await user.type(search, "at least once{Enter}");

    expect(onSelect).toHaveBeenCalledWith({
      kind: "check",
      predicateKind: "toolCalledAtLeastOnce",
    });
  });
});

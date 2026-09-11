import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseRunSetup } from "../case-workspace/case-run-setup";
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: any) => select({ themeMode: "light" }),
}));
const props = {
  open: true,
  onOpenChange: vi.fn(),
  caseTitle: "Create a diagram",
  onStart: vi.fn(),
  runDisabled: false,
  models: [],
  trials: 1,
  hostLabel: "Client",
};
describe("Case run setup", () => {
  it("keeps run controls inside the drawer and runs only on confirmation", async () => {
    const onStart = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <CaseRunSetup
        {...props}
        open={false}
        onStart={onStart}
        onOpenChange={onOpenChange}
      />,
    );
    expect(
      screen.queryByRole("spinbutton", { name: "Iterations per case" }),
    ).toBeNull();
    rerender(
      <CaseRunSetup {...props} onStart={onStart} onOpenChange={onOpenChange} />,
    );
    expect(screen.getByRole("dialog", { name: "Setup Run" })).toBeVisible();
    expect(
      screen.getByRole("spinbutton", { name: "Iterations per case" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Suite settings" })).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Run test case" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("allows configuration while explaining why starting is blocked", () => {
    render(
      <CaseRunSetup {...props} runDisabled disabledReason="Choose a model" />,
    );
    expect(screen.getByText("Choose a model")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Run test case" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: "Iterations per case" }),
    ).toBeEnabled();
  });
});

it("shows the suite-style controls and preserves provider-qualified model selections", async () => {
  const onModelsChange = vi.fn();
  const onTrialsChange = vi.fn();
  render(
    <CaseRunSetup
      {...props}
      trials={3}
      onTrialsChange={onTrialsChange}
      models={["openai/gpt-a", "anthropic/claude-b"]}
      availableModels={
        [
          { id: "gpt-a", provider: "openai", name: "GPT A" },
          { id: "claude-b", provider: "anthropic", name: "Claude B" },
        ] as any
      }
      onModelsChange={onModelsChange}
    />,
  );
  expect(screen.getByText("Where it runs")).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "Client" })).toBeVisible();
  expect(screen.getByRole("columnheader", { name: "Models" })).toBeVisible();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "More iterations" }));
  expect(onTrialsChange).toHaveBeenCalledWith(4);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Remove GPT A model" }));
  expect(onModelsChange).toHaveBeenCalledWith(["anthropic/claude-b"]);
});

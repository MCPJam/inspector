import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseRunSetup } from "../case-workspace/case-run-setup";
// The harness × model picker locks read each host's config; these tests have
// no Convex client for that query, so the reads answer "not known yet".
vi.mock("@/hooks/use-host-harness-targets", () => ({
  useHostHarnessTargets: () => ({}),
  useHostHarnessLoader: () => async () => null,
}));
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-project-environment-capability", () => ({
  useModelSelectionsSupported: () => true,
}));
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

describe("Case run setup reasoning effort", () => {
  const GPT5 = {
    id: "openai/gpt-5",
    name: "GPT-5",
    provider: "openai",
    hosted: true,
    supportedReasoningEfforts: ["low", "high"],
  } as never;
  const selection = (reasoningEffort?: string) =>
    ({
      modelId: "openai/gpt-5",
      source: "hosted",
      fallback: { provider: "none", model: "none" },
      ...(reasoningEffort ? { settings: { reasoningEffort } } : {}),
    }) as never;
  const efforts = (picks: Array<{ selection?: any }>) =>
    picks.map((pick) => pick.selection?.settings?.reasoningEffort);

  async function openEfforts(trigger: HTMLElement) {
    await userEvent.click(trigger);
    await userEvent.click(
      await screen.findByRole("option", { name: /GPT-5/ }),
    );
    return within(await screen.findByTestId("model-effort-menu"));
  }

  it("starts a plain pick at the suite environment's effort and changes it", async () => {
    const onPicksChange = vi.fn();
    render(
      <CaseRunSetup
        {...props}
        models={["openai/openai/gpt-5"]}
        availableModels={[GPT5]}
        environmentSelection={(modelId) =>
          modelId === "openai/gpt-5" ? selection("high") : undefined
        }
        onPicksChange={onPicksChange}
      />,
    );
    const menu = await openEfforts(screen.getByText("High").closest("button")!);
    expect(menu.getByRole("menuitemradio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(menu.getByRole("menuitemradio", { name: "Low" }));
    const picks = onPicksChange.mock.calls.at(-1)![0];
    expect(picks.map((pick: any) => pick.modelValue)).toEqual([
      "openai/openai/gpt-5",
    ]);
    expect(efforts(picks)).toEqual(["low"]);
  });

  it("adds the same model at another effort, so it runs at both", async () => {
    const onPicksChange = vi.fn();
    const key = "openai/openai/gpt-5\u0000low-key";
    render(
      <CaseRunSetup
        {...props}
        models={[key]}
        selections={{ [key]: selection("low") }}
        availableModels={[GPT5]}
        onPicksChange={onPicksChange}
      />,
    );
    const menu = await openEfforts(
      screen.getByRole("button", { name: "Add model" }),
    );
    expect(menu.getByRole("menuitemradio", { name: "Low" })).toBeDisabled();
    await userEvent.click(menu.getByRole("menuitemradio", { name: "High" }));
    const picks = onPicksChange.mock.calls.at(-1)![0];
    expect(picks.map((pick: any) => pick.modelValue)).toEqual([
      "openai/openai/gpt-5",
      "openai/openai/gpt-5",
    ]);
    expect(efforts(picks)).toEqual(["low", "high"]);
  });

  it("offers no effort control where the sheet writes plain model values", () => {
    render(
      <CaseRunSetup
        {...props}
        models={["openai/openai/gpt-5"]}
        availableModels={[GPT5]}
      />,
    );
    expect(screen.queryByText("High")).toBeNull();
    expect(screen.queryByTestId("model-effort-menu")).toBeNull();
  });
});

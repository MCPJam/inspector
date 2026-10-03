import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvalModelChoices } from "../eval-target-matrix";
import type { ModelDefinition } from "@/shared/types";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-project-environment-capability", () => ({
  useModelSelectionsSupported: () => true,
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: any) => select({ themeMode: "light" }),
}));

const GPT5 = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
  supportedReasoningEfforts: ["low", "high"],
} as ModelDefinition;

const selection = {
  modelId: "openai/gpt-5",
  source: "hosted" as const,
  fallback: { provider: "none" as const, model: "none" as const },
};

type Target = {
  modelId: string;
  selection?: { settings?: { reasoningEffort?: string } };
};
const efforts = (targets: Target[]) =>
  targets.map((target) => target.selection?.settings?.reasoningEffort);

/** Open a model menu by its trigger, then open GPT-5's efforts to the side. */
async function openEfforts(trigger: HTMLElement) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
  return within(await screen.findByTestId("model-effort-menu"));
}

describe("EvalModelChoices — reasoning effort", () => {
  it("sets an explicit model's effort from its model menu", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [{ modelId: "openai/gpt-5", selection }],
        }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={[GPT5]}
      />,
    );
    const menu = await openEfforts(
      screen.getByRole("button", { name: /GPT-5$/ }),
    );
    expect(
      menu.getByRole("menuitemradio", { name: "Default" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(menu.getByRole("menuitemradio", { name: "Low" }));
    const next = onChange.mock.calls.at(-1)![0];
    expect(efforts(next.explicitTargets)).toEqual(["low"]);
  });

  it("adds the same model at another effort from Add model, greying out a level already picked", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [
            {
              modelId: "openai/gpt-5",
              selection: { ...selection, settings: { reasoningEffort: "low" } },
            },
          ],
        }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={[GPT5]}
      />,
    );
    const menu = await openEfforts(
      screen.getByRole("button", { name: "Add model" }),
    );
    expect(menu.getByRole("menuitemradio", { name: "Low" })).toBeDisabled();
    await userEvent.click(menu.getByRole("menuitemradio", { name: "High" }));
    const next = onChange.mock.calls.at(-1)![0];
    expect(efforts(next.explicitTargets)).toEqual(["low", "high"]);
  });

  it("changing one effort leaves its sibling target alone", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [
            {
              modelId: "openai/gpt-5",
              selection: { ...selection, settings: { reasoningEffort: "low" } },
            },
            {
              modelId: "openai/gpt-5",
              selection: {
                ...selection,
                settings: { reasoningEffort: "high" },
              },
            },
          ],
        }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={[GPT5]}
      />,
    );
    // The rows read "GPT-5 Low" and "GPT-5 High".
    const menu = await openEfforts(screen.getByText("High").closest("button")!);
    expect(menu.getByRole("menuitemradio", { name: "Low" })).toBeDisabled();
    expect(menu.getByRole("menuitemradio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(menu.getByRole("menuitemradio", { name: "Default" }));
    const next = onChange.mock.calls.at(-1)![0];
    expect(efforts(next.explicitTargets)).toEqual(["low", undefined]);
  });

  it("offers efforts on the client's own model; picking one makes it an explicit pick", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: true, explicitTargets: [] }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        defaultModelId="openai/gpt-5"
        availableModels={[GPT5]}
      />,
    );
    const menu = await openEfforts(
      screen.getByRole("button", { name: /GPT-5$/ }),
    );
    // The client's saved effort isn't known here, so nothing is checked.
    expect(menu.queryByRole("menuitemradio", { checked: true })).toBeNull();
    await userEvent.click(menu.getByRole("menuitemradio", { name: "High" }));
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.includeClientDefaults).toBe(false);
    expect(efforts(next.explicitTargets)).toEqual(["high"]);
  });

  it("picks a model directly where efforts can't be saved", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        effortEditable={false}
        value={{ includeClientDefaults: false, explicitTargets: [] }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={[GPT5]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add model" }));
    await userEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(screen.queryByTestId("model-effort-menu")).toBeNull();
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.explicitTargets.map((t: Target) => t.modelId)).toEqual([
      "openai/gpt-5",
    ]);
  });
});

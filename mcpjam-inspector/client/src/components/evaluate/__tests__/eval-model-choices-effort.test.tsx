import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvalModelChoices } from "../eval-target-matrix";
import type { ModelDefinition } from "@/shared/types";
import { pickEffort } from "@/test/effort";

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

describe("EvalModelChoices — reasoning effort", () => {
  it("writes an effort onto the explicit model's saved selection", async () => {
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
    await userEvent.click(screen.getByTestId("effort-control-trigger"));
    await pickEffort("Low");
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.explicitTargets).toHaveLength(1);
    expect(next.explicitTargets[0].selection.settings.reasoningEffort).toBe(
      "low",
    );
  });

  it("adds another effort of a model as a second target at the next unused level", async () => {
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
    await userEvent.click(screen.getByTestId("choices-add-effort"));
    const next = onChange.mock.calls.at(-1)![0];
    expect(
      next.explicitTargets.map(
        (target: { modelId: string; selection?: typeof selection & { settings?: { reasoningEffort?: string } } }) => [
          target.modelId,
          target.selection?.settings?.reasoningEffort,
        ],
      ),
    ).toEqual([
      ["openai/gpt-5", "low"],
      ["openai/gpt-5", "high"],
    ]);
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
              selection: { ...selection, settings: { reasoningEffort: "high" } },
            },
          ],
        }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={[GPT5]}
      />,
    );
    // Both efforts are used: no further level to add.
    expect(screen.queryByTestId("choices-add-effort")).toBeNull();
    const chips = screen.getAllByTestId("effort-control-trigger");
    expect(chips).toHaveLength(2);
    await userEvent.click(chips[1]!);
    await pickEffort("Default");
    const next = onChange.mock.calls.at(-1)![0];
    expect(
      next.explicitTargets.map(
        (target: { selection?: { settings?: { reasoningEffort?: string } } }) =>
          target.selection?.settings?.reasoningEffort,
      ),
    ).toEqual(["low", undefined]);
  });

  it("offers no chip on the inherited client default", () => {
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: true, explicitTargets: [] }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        defaultModelId="openai/gpt-5"
        availableModels={[GPT5]}
      />,
    );
    expect(screen.queryByTestId("effort-control-trigger")).toBeNull();
  });
});

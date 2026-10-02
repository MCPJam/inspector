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
          explicitModelIds: ["openai/gpt-5"],
          explicitModelSelections: { "openai/gpt-5": selection },
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
    expect(
      next.explicitModelSelections["openai/gpt-5"].settings.reasoningEffort,
    ).toBe("low");
  });

  it("offers no chip on the inherited client default", () => {
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: true, explicitModelIds: [] }}
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

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteOverviewModelBar } from "../suite-overview-model-bar";

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => null,
}));
import type { EvalCase } from "../types";
import type { ModelDefinition } from "@/shared/types";

describe("SuiteOverviewModelBar", () => {
  const availableModels: ModelDefinition[] = [
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
    },
    {
      id: "gpt-5-nano",
      name: "GPT-5 Nano",
      provider: "openai",
    },
  ];

  const testCases: EvalCase[] = [
    {
      _id: "c1",
      testSuiteId: "s1",
      createdBy: "u1",
      title: "Case 1",
      query: "q",
      models: [
        { model: "claude-haiku-4-5", provider: "anthropic" },
        { model: "gpt-5-nano", provider: "openai" },
      ],
      runs: 1,
      expectedToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    } as EvalCase,
  ];

  it("renders model chips from case data", () => {
    renderWithProviders(
      <SuiteOverviewModelBar
        testCases={testCases}
        availableModels={availableModels}
      />,
    );

    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.getByText("GPT-5 Nano")).toBeInTheDocument();
  });

  it("calls onUpdate when a model is removed", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(
      <SuiteOverviewModelBar
        testCases={testCases}
        availableModels={availableModels}
        onUpdate={onUpdate}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Remove GPT-5 Nano/i }),
    );

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        model: "claude-haiku-4-5",
        provider: "anthropic",
      }),
    ]);
  });

  it("hides edit controls in read-only mode", () => {
    renderWithProviders(
      <SuiteOverviewModelBar
        testCases={testCases}
        availableModels={availableModels}
        readOnly
        onUpdate={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Add model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove/i }),
    ).not.toBeInTheDocument();
  });

  it("shows at most three models from case data", () => {
    const fourModels: ModelDefinition[] = [
      ...availableModels,
      { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai" },
      { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    ];

    const casesWithFour: EvalCase[] = [
      {
        ...testCases[0]!,
        models: [
          { model: "claude-haiku-4-5", provider: "anthropic" },
          { model: "gpt-5-nano", provider: "openai" },
          { model: "gpt-4.1-mini", provider: "openai" },
          { model: "claude-sonnet", provider: "anthropic" },
        ],
      } as EvalCase,
    ];

    renderWithProviders(
      <SuiteOverviewModelBar
        testCases={casesWithFour}
        availableModels={fourModels}
      />,
    );

    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.getByText("GPT-5 Nano")).toBeInTheDocument();
    expect(screen.getByText("GPT-4.1 mini")).toBeInTheDocument();
    expect(screen.queryByText("Claude Sonnet")).not.toBeInTheDocument();
  });

  it("hides add model when three models are already selected", () => {
    const threeModels: ModelDefinition[] = [
      ...availableModels,
      { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai" },
    ];

    const casesWithThree: EvalCase[] = [
      {
        ...testCases[0]!,
        models: [
          { model: "claude-haiku-4-5", provider: "anthropic" },
          { model: "gpt-5-nano", provider: "openai" },
          { model: "gpt-4.1-mini", provider: "openai" },
        ],
      } as EvalCase,
    ];

    renderWithProviders(
      <SuiteOverviewModelBar
        testCases={casesWithThree}
        availableModels={threeModels}
        onUpdate={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Add model" }),
    ).not.toBeInTheDocument();
  });
});

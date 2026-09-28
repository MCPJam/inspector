import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JudgesSection, pruneEmpty } from "../judges-section";
import type { EvalJudgeConfig } from "../types";
import type { ModelDefinition } from "@/shared/types";
import { MANAGED_DEFAULT_JUDGE_MODEL } from "@/components/shared/session-quality/judge-config";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

function renderBare(value: EvalJudgeConfig | undefined) {
  const onChange = vi.fn();
  render(
    <JudgesSection
      chrome="bare"
      value={value}
      availableModels={[]}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("JudgesSection — bare (suite settings) auto-grade toggle", () => {
  it("turning it ON enables AND auto-runs (one switch = auto-grade every run)", async () => {
    const user = userEvent.setup();
    const { onChange } = renderBare({ goalCompletion: { enabled: true, autoRun: false } });
    const sw = screen.getByRole("switch", {
      name: /auto-grade every run/i,
    });
    expect(sw).toHaveAttribute("data-state", "unchecked");

    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: expect.objectContaining({ enabled: true, autoRun: true }),
    });
  });

  it("shows ON only when it will actually auto-grade (enabled && autoRun)", () => {
    renderBare({ goalCompletion: { enabled: true, autoRun: true } });
    expect(
      screen.getByRole("switch", { name: /auto-grade every run/i }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("turning it OFF disables the judge", async () => {
    const user = userEvent.setup();
    const { onChange } = renderBare({
      goalCompletion: { enabled: true, autoRun: true },
    });
    await user.click(
      screen.getByRole("switch", { name: /auto-grade every run/i }),
    );
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: expect.objectContaining({ enabled: false }),
    });
  });

  it("surfaces that it uses credits", () => {
    renderBare({ goalCompletion: { enabled: true, autoRun: true } });
    expect(screen.getByText(/uses credits/i)).toBeInTheDocument();
  });
});

describe("pruneEmpty keeps a config that still means something", () => {
  it("drops a config with nothing set", () => {
    expect(pruneEmpty({ goalCompletion: {} })).toBeUndefined();
    expect(pruneEmpty({})).toBeUndefined();
  });

  it("treats an empty model string as nothing", () => {
    expect(pruneEmpty({ goalCompletion: { judgeModel: "" } })).toBeUndefined();
  });

  it("KEEPS a config whose only field is presentation severity", () => {
    expect(pruneEmpty({ goalCompletion: { severity: "warn" } })).toEqual({
      goalCompletion: { severity: "warn" },
    });
  });

  it("keeps a stored groundedness slot when goal completion is empty", () => {
    expect(
      pruneEmpty({
        goalCompletion: {},
        groundedness: { role: "advisory" },
      }),
    ).toEqual({ groundedness: { role: "advisory" } });
  });

  it("keeps a stored rubric-checks slot, questions and all", () => {
    // This section edits goal completion only. Dropping a slot it does not
    // own would read, to every other writer, as a deliberate clear of the
    // suite's rubric checks and their authored questions.
    const rubricChecks = {
      enabled: false,
      questions: [
        {
          id: "tone",
          kind: "score" as const,
          label: "Tone",
          instructions: "How warm was the reply?",
          levels: ["Cold", "Neutral", "Warm"],
          pass: { minLevel: 2 },
        },
      ],
    };
    expect(pruneEmpty({ goalCompletion: {}, rubricChecks })).toEqual({
      rubricChecks,
    });
    expect(
      pruneEmpty({
        goalCompletion: { threshold: 0.8 },
        groundedness: { role: "advisory" },
        rubricChecks,
      }),
    ).toEqual({
      goalCompletion: { threshold: 0.8 },
      groundedness: { role: "advisory" },
      rubricChecks,
    });
  });

  it("KEEPS a config whose only field is the gating role", () => {
    // The case that matters. `enabled` may legitimately be absent — the
    // backend resolves an absent one to on — so a gating suite can carry
    // `role` and nothing else. Resetting the model to the managed default
    // clears `judgeModel`, and before `role` was counted here that made the
    // whole config prune away: a gate the organization had to earn, erased by
    // an unrelated edit, with no error and no toast.
    expect(pruneEmpty({ goalCompletion: { role: "gating" } })).toEqual({
      goalCompletion: { role: "gating" },
    });
    expect(pruneEmpty({ goalCompletion: { role: "advisory" } })).toEqual({
      goalCompletion: { role: "advisory" },
    });
  });

  it("keeps each of the other meaningful fields on its own", () => {
    for (const gc of [
      { enabled: false },
      { judgeModel: "openai/gpt-5.4-mini" },
      { threshold: 0.8 },
      { autoRun: true },
    ]) {
      expect(pruneEmpty({ goalCompletion: gc })).toEqual({
        goalCompletion: gc,
      });
    }
  });
});

it("uses the backend's inherited automatic setting", () => {
  // A suite that has never touched its judge settings reads the resolved
  // policy off the backend rather than assuming anything. There is no
  // deployment pause to report any more: grading stops through these
  // settings, so the switch IS the whole story.
  render(
    <JudgesSection
      chrome="panel"
      value={undefined}
      availableModels={[]}
      onChange={() => {}}
      policy={{
        contractVersion: 4,
        effective: {
          enabled: true,
          autoRun: true,
          judgeModel: "openai/gpt-5.4-mini",
          threshold: 0.7,
          role: "advisory",
        },
        automatic: true,
      }}
    />,
  );
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});


it("does not call unknown inheritance off", () => {
  renderBare(undefined);
  expect(screen.getByText("Grading state unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});

it("shows the backend automatic default for an untouched suite", () => {
  render(<JudgesSection value={undefined} availableModels={[]} onChange={vi.fn()} policy={{ contractVersion: 4, automatic: true, effective: { enabled: true, autoRun: true, judgeModel: "openai/gpt-5.4-mini", threshold: 0.7, role: "advisory" } }} />);
  expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
});

describe("JudgesSection judge model picker (purpose: judge)", () => {
  const OBSERVED_AT = 1_790_000_000_000;
  const hostedHaiku: ModelDefinition = {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    hosted: true,
  };
  const orgTwin: ModelDefinition = {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku via org",
    provider: "openrouter",
    hosted: false,
    orgProvider: { providerKey: "openrouter", id: "orgprov_1" },
  };
  const bareByok: ModelDefinition = {
    id: "gpt-4o",
    name: "GPT-4o (own key)",
    provider: "openai",
    hosted: false,
  };

  function renderPicker(
    availableModels: ModelDefinition[],
    judgeModel?: string,
  ) {
    const onChange = vi.fn();
    render(
      <JudgesSection
        chrome="panel"
        value={{
          goalCompletion: {
            enabled: true,
            autoRun: true,
            ...(judgeModel ? { judgeModel } : {}),
          },
        }}
        availableModels={availableModels}
        onChange={onChange}
        saveModelSelections
      />,
    );
    return { onChange };
  }

  const option = (name: RegExp) => screen.getByRole("option", { name });

  it("offers hosted models only and saves the picked row's selection", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker([hostedHaiku, orgTwin, bareByok]);
    await user.click(screen.getByRole("button", { name: "Judge model" }));

    expect(screen.queryByText("Haiku via org")).not.toBeInTheDocument();
    expect(screen.queryByText("GPT-4o (own key)")).not.toBeInTheDocument();
    // The managed default is always offered.
    expect(
      option(
        new RegExp(
          MANAGED_DEFAULT_JUDGE_MODEL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
        ),
      ),
    ).toBeInTheDocument();

    await user.click(option(/Claude Haiku 4\.5/));
    expect(onChange).toHaveBeenCalledWith({
      goalCompletion: expect.objectContaining({
        judgeModel: "anthropic/claude-haiku-4.5",
        judgeSelection: {
          modelId: "anthropic/claude-haiku-4.5",
          source: "hosted",
          fallback: { provider: "none", model: "none" },
        },
      }),
    });
  });

  it("hides hosted models the catalog does not admit as judges once it reports observations", async () => {
    const user = userEvent.setup();
    renderPicker([
      {
        ...hostedHaiku,
        catalogObservedAt: OBSERVED_AT,
        judgeEligible: true,
      },
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "openai",
        hosted: true,
        catalogObservedAt: OBSERVED_AT,
        judgeEligible: false,
      },
      {
        // No judge_eligible field: the ZDR observation decides; unknown is
        // not eligible.
        id: "openai/gpt-new",
        name: "GPT New",
        provider: "openai",
        hosted: true,
        catalogObservedAt: OBSERVED_AT,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Judge model" }));
    expect(option(/Claude Haiku 4\.5/)).toBeInTheDocument();
    expect(screen.queryByText("GPT-5 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("GPT New")).not.toBeInTheDocument();
  });

  it("keeps every hosted model while the catalog carries no observations", async () => {
    const user = userEvent.setup();
    renderPicker([
      hostedHaiku,
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "openai",
        hosted: true,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Judge model" }));
    expect(option(/Claude Haiku 4\.5/)).toBeInTheDocument();
    expect(option(/GPT-5 Mini/)).toBeInTheDocument();
  });

  it("shows an ineligible current value, disabled and marked, without offering it", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker([hostedHaiku, bareByok], "gpt-4o");
    const trigger = screen.getByRole("button", { name: "Judge model" });
    expect(trigger).toHaveTextContent("GPT-4o (own key)");
    await user.click(trigger);

    const current = option(/GPT-4o \(own key\)/);
    expect(current).toHaveAttribute("aria-disabled", "true");
    expect(current).toHaveTextContent("Not eligible");
    await user.click(current);
    expect(onChange).not.toHaveBeenCalled();
  });
});

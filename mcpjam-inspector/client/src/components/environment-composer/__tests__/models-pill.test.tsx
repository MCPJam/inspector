import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ModelsPill,
  modelsPillTriggerLabel,
} from "../models-pill";
import type { ModelSelection } from "../environment-stack";

const extraModels = vi.hoisted(() => ({
  current: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      {
        id: "locked-model",
        name: "Locked",
        disabled: true,
        disabledReason: "Out of credits",
      },
      ...extraModels.current,
    ],
  }),
}));

function renderPill(
  value: ModelSelection,
  extras: Partial<Parameters<typeof ModelsPill>[0]> = {}
) {
  const onChange = vi.fn();
  render(
    <ModelsPill
      projectId="proj-1"
      value={value}
      onChange={onChange}
      mode={extras.mode ?? "multiple"}
      budget={extras.budget}
      testId="models"
      {...extras}
    />
  );
  return onChange;
}

describe("modelsPillTriggerLabel", () => {
  it("says models, or the inherited/explicit name when one is selected", () => {
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: true,
        explicitModelIds: [],
      })
    ).toBe("models");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: true, explicitModelIds: [] },
        { clientDefaultLabel: "gpt-4", modelName: () => "GPT-4" }
      )
    ).toBe("GPT-4");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: true,
        explicitModelIds: ["a", "b"],
      })
    ).toBe("models +2");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: true, explicitModelIds: ["a", "b"] },
        { clientDefaultLabel: "gpt-4", modelName: () => "GPT-4" }
      )
    ).toBe("GPT-4 +2");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: false,
        explicitModelIds: ["a", "b"],
      })
    ).toBe("2 models");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: false, explicitModelIds: ["google/gemini"] },
        { modelName: () => "Gemini 2.5 Flash" }
      )
    ).toBe("Gemini 2.5 Flash");
  });
});

describe("ModelsPill", () => {
  it("labels the trigger models, or the inherited client-default name", () => {
    const { unmount } = render(
      <ModelsPill
        projectId="proj-1"
        value={{ includeClientDefaults: true, explicitModelIds: [] }}
        onChange={vi.fn()}
        testId="models"
      />
    );
    expect(screen.getByTestId("models")).toHaveTextContent("models");
    unmount();
    render(
      <ModelsPill
        projectId="proj-1"
        value={{ includeClientDefaults: true, explicitModelIds: [] }}
        onChange={vi.fn()}
        clientDefaultLabel="google/gemini-2.5-flash"
        testId="models"
      />
    );
    expect(screen.getByTestId("models")).toHaveTextContent("Gemini 2.5 Flash");
  });

  it("checks Client defaults initially and lists catalog models", async () => {
    const user = userEvent.setup();
    renderPill({ includeClientDefaults: true, explicitModelIds: [] });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const defaults = screen.getByRole("checkbox", { name: "Client defaults" });
    expect(defaults).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Gemini 2.5 Flash" })).toBeInTheDocument();
  });

  it("disables a model option that would exceed the product cap", async () => {
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitModelIds: [] },
      {
        budget: { hostCount: 3, choiceCount: 1, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    // 3 hosts × (1+1) = 6 ≤ 10, so Gemini is still available.
    expect(
      screen.getByRole("checkbox", { name: "Gemini 2.5 Flash" })
    ).not.toBeDisabled();
  });

  it("disables a model option when the product would exceed 10", async () => {
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitModelIds: ["m1", "m2"] },
      {
        budget: { hostCount: 3, choiceCount: 3, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(
      screen.getByRole("checkbox", { name: "Gemini 2.5 Flash" })
    ).toBeDisabled();
  });

  it("replaces the sole model choice at the cap instead of disabling alternatives", async () => {
    const user = userEvent.setup();
    const onChange = renderPill(
      { includeClientDefaults: true, explicitModelIds: [] },
      {
        budget: { hostCount: 6, choiceCount: 1, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    const gemini = screen.getByRole("checkbox", { name: "Gemini 2.5 Flash" });
    expect(gemini).not.toBeDisabled();
    await user.click(gemini);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: false,
      explicitModelIds: ["google/gemini-2.5-flash"],
    });
  });

  it("keeps a catalog-disabled model disabled", async () => {
    const user = userEvent.setup();
    renderPill({ includeClientDefaults: true, explicitModelIds: [] });
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByRole("checkbox", { name: "Locked" })).toBeDisabled();
  });

  it("lets the user remove a selected model that is no longer in the catalog", async () => {
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitModelIds: ["retired/old-model"],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const stale = screen.getByRole("checkbox", { name: "retired/old-model" });
    expect(stale).toBeChecked();
    expect(stale).not.toBeDisabled();
    await user.click(stale);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: true,
      explicitModelIds: [],
    });
  });

  it("lets the user deselect a persisted locked model", async () => {
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitModelIds: ["locked-model"],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const locked = screen.getByRole("checkbox", { name: "Locked" });
    expect(locked).toBeChecked();
    expect(locked).not.toBeDisabled();
    await user.click(locked);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: true,
      explicitModelIds: [],
    });
  });

  it("single mode replaces the selection", async () => {
    const user = userEvent.setup();
    const onChange = renderPill(
      { includeClientDefaults: true, explicitModelIds: [] },
      { mode: "single" }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    await user.click(screen.getByRole("checkbox", { name: "Gemini 2.5 Flash" }));
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: false,
      explicitModelIds: ["google/gemini-2.5-flash"],
    });
  });
});

describe("ModelsPill — harness × model support", () => {
  const HARNESS_MODELS = [
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
  ];

  it("disables, with the reason, a model the client's harness cannot run", async () => {
    extraModels.current = HARNESS_MODELS;
    try {
      const user = userEvent.setup();
      renderPill(
        { includeClientDefaults: true, explicitModelIds: [] },
        { harnessTargets: [{ harnessId: "claude-code" }] }
      );
      await user.click(screen.getByRole("button", { name: "Models" }));
      // Claude Code only runs Anthropic models.
      expect(
        screen.getByRole("checkbox", { name: "GPT-5.6 Luna" })
      ).toBeDisabled();
      expect(
        screen.getByTestId("models-harness-reason-openai/gpt-5.6-luna")
      ).toHaveTextContent("the Claude Code harness can't run this host's model");
      // Not verified on the pinned runtime ⇒ refused for an eval.
      expect(
        screen.getByRole("checkbox", { name: "Claude Fable 5" })
      ).toBeDisabled();
      expect(
        screen.getByTestId("models-harness-reason-anthropic/claude-fable-5")
      ).toHaveTextContent(/^not verified for claude-code \d+\.\d+\.\d+$/);
      // Supported stays pickable.
      expect(
        screen.getByRole("checkbox", { name: "Claude Sonnet 4.5" })
      ).toBeEnabled();
    } finally {
      extraModels.current = [];
    }
  });

  it("keeps a model pickable when some selected client can run it", async () => {
    extraModels.current = HARNESS_MODELS;
    try {
      const user = userEvent.setup();
      renderPill(
        { includeClientDefaults: true, explicitModelIds: [] },
        // An emulated client runs anything; the Codex cell is skipped at
        // resolve time instead.
        { harnessTargets: [{ harnessId: "codex" }, null] }
      );
      await user.click(screen.getByRole("button", { name: "Models" }));
      expect(
        screen.getByRole("checkbox", { name: "GPT-5.6 Luna" })
      ).toBeEnabled();
    } finally {
      extraModels.current = [];
    }
  });

  it("allows an unverified pair where the purpose is chat", async () => {
    extraModels.current = HARNESS_MODELS;
    try {
      const user = userEvent.setup();
      renderPill(
        { includeClientDefaults: true, explicitModelIds: [] },
        { harnessTargets: [{ harnessId: "claude-code" }], purpose: "chat" }
      );
      await user.click(screen.getByRole("button", { name: "Models" }));
      expect(
        screen.getByRole("checkbox", { name: "Claude Fable 5" })
      ).toBeEnabled();
      expect(
        screen.getByRole("checkbox", { name: "GPT-5.6 Luna" })
      ).toBeDisabled();
    } finally {
      extraModels.current = [];
    }
  });
});

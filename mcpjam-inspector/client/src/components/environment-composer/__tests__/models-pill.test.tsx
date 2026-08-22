import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ModelsPill,
  modelsPillTriggerLabel,
} from "../models-pill";
import type { ModelSelection } from "../environment-stack";

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
  it("names Client defaults, plus extras, or a model count", () => {
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: true,
        explicitModelIds: [],
      })
    ).toBe("Client defaults");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: true,
        explicitModelIds: ["a", "b"],
      })
    ).toBe("Client defaults +2");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: false,
        explicitModelIds: ["a", "b"],
      })
    ).toBe("2 models");
  });
});

describe("ModelsPill", () => {
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

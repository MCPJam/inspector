import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvalModelChoices } from "../eval-target-matrix";
import type { ModelDefinition } from "@/shared/types";

vi.mock("@/hooks/use-host-harness-targets", () => ({
  useHostHarnessTargets: () => ({}),
  useHostHarnessLoader: () => async () => null,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: any) => select({ themeMode: "light" }),
}));

const MODELS = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openai" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
] as ModelDefinition[];

async function openAddModel(harness: { harnessId: string } | null) {
  render(
    <EvalModelChoices
      value={{ includeClientDefaults: true, explicitModelIds: [] }}
      onChange={vi.fn()}
      disabled={false}
      testId="choices"
      availableModels={MODELS}
      harness={harness}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /Add model/ }));
}

function optionFor(name: RegExp) {
  return screen
    .getAllByRole("option")
    .find((option) => name.test(option.textContent ?? ""));
}

describe("EvalModelChoices — harness × model support", () => {
  it("disables a model the client's harness can't run", async () => {
    await openAddModel({ harnessId: "codex" });
    const luna = optionFor(/GPT-5\.6 Luna/);
    expect(luna).toBeDefined();
    expect(luna).toHaveAttribute("aria-disabled", "true");
    const supported = optionFor(/GPT-5\.5/);
    expect(supported).not.toHaveAttribute("aria-disabled", "true");
    expect(
      within(screen.getByTestId("choices")).getByRole("button", {
        name: /Add model/,
      }),
    ).toBeVisible();
  });

  it("disables nothing for an emulated client", async () => {
    await openAddModel(null);
    expect(optionFor(/GPT-5\.6 Luna/)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

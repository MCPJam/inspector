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

// While the organization requires its own keys the list holds only its models.
const ORG_MODELS = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    hosted: false,
    orgProvider: { providerKey: "anthropic", id: "conn_1" },
  },
] as ModelDefinition[];

describe("EvalModelChoices — organization requires its own keys", () => {
  it("warns about a saved hosted target on its trigger, by catalog name, and never lists it", async () => {
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [{ modelId: "anthropic/claude-haiku-4.5" }],
        }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
        requireOrgKeys
      />,
    );

    const warning = screen.getByTestId("model-trigger-org-keys-warning");
    expect(warning).toHaveTextContent(
      "Claude Haiku 4.5 isn't allowed here. Choose an organization model.",
    );

    await userEvent
      .setup()
      .click(within(screen.getByTestId("choices")).getAllByRole("button")[0]!);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Claude Sonnet 4.5");
    expect(screen.queryByText("Free models")).not.toBeInTheDocument();
  });

  it("keeps the raw id, without a warning, when the policy is off", () => {
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [{ modelId: "acme/retired" }],
        }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
      />,
    );
    expect(
      screen.queryByTestId("model-trigger-org-keys-warning"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("choices")).toHaveTextContent("acme/retired");
  });
});

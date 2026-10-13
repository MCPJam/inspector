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
  usePreferencesStore: (select: (state: { themeMode: "light" }) => unknown) =>
    select({ themeMode: "light" }),
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

  it("keeps each disallowed target's effort beside its warning", () => {
    // Two saved targets of one model differ only by effort; without it both
    // triggers would read the same.
    const hosted = {
      modelId: "anthropic/claude-haiku-4.5",
      source: "hosted" as const,
      fallback: { provider: "none" as const, model: "none" as const },
    };
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [
            {
              modelId: "anthropic/claude-haiku-4.5",
              selection: { ...hosted, settings: { reasoningEffort: "low" } },
            },
            {
              modelId: "anthropic/claude-haiku-4.5",
              selection: { ...hosted, settings: { reasoningEffort: "high" } },
            },
          ],
        }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
        requireOrgKeys
      />,
    );
    expect(
      screen.getAllByTestId("model-trigger-org-keys-warning"),
    ).toHaveLength(2);
    const choices = within(screen.getByTestId("choices"));
    expect(choices.getByText("Low")).toBeInTheDocument();
    expect(choices.getByText("High")).toBeInTheDocument();
  });

  it("warns about a saved hosted target that an org connection also lists, by source and connection", () => {
    // The org's OpenRouter connection lists the hosted catalog's id. Only the
    // target saved on that connection is allowed; the hosted one still warns.
    const fallback = { provider: "none" as const, model: "none" as const };
    const modelId = "anthropic/claude-haiku-4.5";
    const openRouterRow = {
      id: modelId,
      name: "Claude Haiku 4.5",
      provider: "openrouter",
      hosted: false,
      orgProvider: { providerKey: "openrouter", id: "conn_or" },
    } as ModelDefinition;
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [
            { modelId, selection: { modelId, source: "hosted", fallback } },
            {
              modelId,
              selection: {
                modelId,
                source: "org",
                connectionRef: { kind: "orgProvider", id: "conn_or" },
                fallback,
              },
            },
          ],
        }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        availableModels={[...ORG_MODELS, openRouterRow]}
        requireOrgKeys
      />,
    );
    expect(
      screen.getAllByTestId("model-trigger-org-keys-warning"),
    ).toHaveLength(1);
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

  // The org Anthropic row's id is bare. Saved as that bare id, it would run as
  // a legacy id, which the policy refuses.
  const orgSonnet = {
    modelId: "anthropic/claude-sonnet-4.5",
    selection: {
      modelId: "anthropic/claude-sonnet-4.5",
      source: "org" as const,
      connectionRef: { kind: "orgProvider" as const, id: "conn_1" },
      nativeModelId: "claude-sonnet-4-5",
      fallback: { provider: "none" as const, model: "none" as const },
    },
  };

  it.each([
    [
      "a removed connection",
      {
        ...orgSonnet,
        selection: {
          ...orgSonnet.selection,
          connectionRef: { kind: "orgProvider" as const, id: "conn_removed" },
        },
      },
    ],
    ["a legacy id without a connection", { modelId: "claude-sonnet-4-5" }],
  ])(
    "warns about %s even when another connection lists the same model",
    (_label, target) => {
      render(
        <EvalModelChoices
          value={{ includeClientDefaults: false, explicitTargets: [target] }}
          onChange={vi.fn()}
          disabled={false}
          testId="choices"
          availableModels={ORG_MODELS}
          requireOrgKeys
        />,
      );
      expect(
        screen.getByTestId("model-trigger-org-keys-warning"),
      ).toBeInTheDocument();
    },
  );

  it("saves a bare-id org row picked in place of a target with its org selection", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{
          includeClientDefaults: false,
          explicitTargets: [{ modelId: "anthropic/claude-haiku-4.5" }],
        }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
        requireOrgKeys
      />,
    );
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId("choices")).getAllByRole("button")[0]!,
    );
    await user.click(
      screen.getByRole("option", { name: /Claude Sonnet 4\.5/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      includeClientDefaults: false,
      explicitTargets: [orgSonnet],
    });
  });

  it("saves a bare-id org row from Add model with its org selection", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: false, explicitTargets: [] }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
        requireOrgKeys
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add model/ }));
    await user.click(
      screen.getByRole("option", { name: /Claude Sonnet 4\.5/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      includeClientDefaults: false,
      explicitTargets: [orgSonnet],
    });
  });

  it("reads that saved target back as the org row, without a warning", () => {
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: false, explicitTargets: [orgSonnet] }}
        onChange={vi.fn()}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
        requireOrgKeys
      />,
    );
    expect(
      screen.queryByTestId("model-trigger-org-keys-warning"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("choices")).toHaveTextContent(
      "Claude Sonnet 4.5",
    );
  });

  it("keeps the bare id of a picked org row when the policy is off", async () => {
    const onChange = vi.fn();
    render(
      <EvalModelChoices
        value={{ includeClientDefaults: false, explicitTargets: [] }}
        onChange={onChange}
        disabled={false}
        testId="choices"
        availableModels={ORG_MODELS}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Add model/ }));
    await user.click(
      screen.getByRole("option", { name: /Claude Sonnet 4\.5/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "claude-sonnet-4-5" }],
    });
  });
});

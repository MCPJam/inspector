import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ModelsPill,
  modelsPillTriggerLabel,
} from "../models-pill";
import type { ModelSelection } from "../environment-stack";

const mockModels = vi.hoisted(() => ({
  requireOrgKeys: false,
  availableModels: [
    {
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "google",
      hosted: true,
    },
    {
      id: "locked-model",
      name: "Locked",
      provider: "openai",
      hosted: true,
      disabled: true,
      disabledReason: "Out of credits",
    },
  ] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: mockModels.availableModels,
    requireOrgKeys: mockModels.requireOrgKeys,
  }),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => <span aria-hidden="true" />,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (
    selector: (state: { themeMode: "light" | "dark" }) => unknown
  ) => selector({ themeMode: "light" }),
}));

const DEFAULT_MODELS = [...mockModels.availableModels];

beforeEach(() => {
  mockModels.availableModels = [...DEFAULT_MODELS];
  mockModels.requireOrgKeys = false;
});

/** A model row in the open picker (cmdk option; `aria-checked` in multi). */
const option = (name: RegExp | string) =>
  screen.getByRole("option", {
    name: typeof name === "string" ? new RegExp(`^${name}`) : name,
  });

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
        explicitTargets: [],
      })
    ).toBe("models");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: true, explicitTargets: [] },
        { clientDefaultLabel: "gpt-4", modelName: () => "GPT-4" }
      )
    ).toBe("GPT-4");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: true,
        explicitTargets: [{ modelId: "a" }, { modelId: "b" }],
      })
    ).toBe("models +2");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: true, explicitTargets: [{ modelId: "a" }, { modelId: "b" }] },
        { clientDefaultLabel: "gpt-4", modelName: () => "GPT-4" }
      )
    ).toBe("GPT-4 +2");
    expect(
      modelsPillTriggerLabel({
        includeClientDefaults: false,
        explicitTargets: [{ modelId: "a" }, { modelId: "b" }],
      })
    ).toBe("2 models");
    expect(
      modelsPillTriggerLabel(
        { includeClientDefaults: false, explicitTargets: [{ modelId: "google/gemini" }] },
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
        value={{ includeClientDefaults: true, explicitTargets: [] }}
        onChange={vi.fn()}
        testId="models"
      />
    );
    expect(screen.getByTestId("models")).toHaveTextContent("models");
    unmount();
    render(
      <ModelsPill
        projectId="proj-1"
        value={{ includeClientDefaults: true, explicitTargets: [] }}
        onChange={vi.fn()}
        clientDefaultLabel="google/gemini-2.5-flash"
        testId="models"
      />
    );
    expect(screen.getByTestId("models")).toHaveTextContent("Gemini 2.5 Flash");
  });

  it("checks Client defaults initially and lists catalog models", async () => {
    const user = userEvent.setup();
    renderPill({ includeClientDefaults: true, explicitTargets: [] });
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option("Client defaults")).toHaveAttribute("aria-checked", "true");
    expect(option("Gemini 2.5 Flash")).toHaveAttribute("aria-checked", "false");
  });

  it("disables a model option that would exceed the product cap", async () => {
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      {
        budget: { hostCount: 3, choiceCount: 1, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    // 3 hosts × (1+1) = 6 ≤ 10, so Gemini is still available.
    expect(option("Gemini 2.5 Flash")).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("disables a model option when the product would exceed 10", async () => {
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitTargets: [{ modelId: "m1" }, { modelId: "m2" }] },
      {
        budget: { hostCount: 3, choiceCount: 3, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option("Gemini 2.5 Flash")).toHaveAttribute("aria-disabled", "true");
  });

  it("replaces the sole model choice at the cap instead of disabling alternatives", async () => {
    const user = userEvent.setup();
    const onChange = renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      {
        budget: { hostCount: 6, choiceCount: 1, maxTargets: 10 },
      }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    const gemini = option("Gemini 2.5 Flash");
    expect(gemini).not.toHaveAttribute("aria-disabled", "true");
    await user.click(gemini);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: false,
      // The picked row's saved selection rides on the target.
      explicitTargets: [
        {
          modelId: "google/gemini-2.5-flash",
          selection: expect.objectContaining({
            modelId: "google/gemini-2.5-flash",
            source: "hosted",
          }),
        },
      ],
    });
  });

  it("keeps a catalog-disabled model disabled", async () => {
    const user = userEvent.setup();
    renderPill({ includeClientDefaults: true, explicitTargets: [] });
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option("Locked")).toHaveAttribute("aria-disabled", "true");
  });

  it("lets the user remove a selected model that is no longer in the catalog", async () => {
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitTargets: [{ modelId: "retired/old-model" }],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const stale = option("retired/old-model");
    expect(stale).toHaveAttribute("aria-checked", "true");
    expect(stale).toHaveTextContent("No longer in the catalog");
    expect(stale).not.toHaveAttribute("aria-disabled", "true");
    await user.click(stale);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: true,
      explicitTargets: [],
    });
  });

  it("warns on the trigger about a picked model the organization's policy no longer allows", async () => {
    mockModels.requireOrgKeys = true;
    mockModels.availableModels = [
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        hosted: false,
        orgProvider: { providerKey: "anthropic", id: "conn_1" },
      },
    ];
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "anthropic/claude-haiku-4.5" }],
    });
    const trigger = screen.getByRole("button", { name: "Models" });
    expect(trigger).toHaveAttribute(
      "title",
      "Claude Haiku 4.5 isn't allowed here. Choose an organization model.",
    );
    expect(trigger).toHaveTextContent("Claude Haiku 4.5");
    expect(
      screen.getByTestId("models-pill-org-keys-warning"),
    ).toBeInTheDocument();

    await user.click(trigger);
    // Removable by its catalog name, never offered as a model row.
    const stale = option("Claude Haiku 4.5");
    expect(stale).toHaveTextContent(
      "Not allowed here. Choose an organization model.",
    );
    expect(
      screen.queryByRole("option", { name: /anthropic\/claude-haiku-4\.5/ }),
    ).not.toBeInTheDocument();
    await user.click(stale);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: false,
      explicitTargets: [],
    });
  });

  it("lets the user deselect a persisted locked model", async () => {
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitTargets: [{ modelId: "locked-model" }],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const locked = option("Locked");
    expect(locked).toHaveAttribute("aria-checked", "true");
    expect(locked).not.toHaveAttribute("aria-disabled", "true");
    await user.click(locked);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: true,
      explicitTargets: [],
    });
  });

  it("single mode replaces the selection", async () => {
    const user = userEvent.setup();
    const onChange = renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      { mode: "single" }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    await user.click(option("Gemini 2.5 Flash"));
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: false,
      // The picked row's saved selection rides on the target.
      explicitTargets: [
        {
          modelId: "google/gemini-2.5-flash",
          selection: expect.objectContaining({
            modelId: "google/gemini-2.5-flash",
            source: "hosted",
          }),
        },
      ],
    });
  });
});

describe("ModelsPill on the one picker", () => {
  const hosted = {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    hosted: true,
  };
  const orgTwin = {
    id: "openai/gpt-4o",
    name: "GPT-4o via org",
    provider: "openrouter",
    hosted: false,
    orgProvider: { providerKey: "openrouter", id: "orgprov_1" },
  };
  const orgSelection = {
    modelId: "openai/gpt-4o",
    source: "org" as const,
    connectionRef: { kind: "orgProvider" as const, id: "orgprov_1" },
    fallback: { provider: "none" as const, model: "none" as const },
  };

  it("keeps the hosted row and an org row with the same id apart", async () => {
    mockModels.availableModels = [hosted, orgTwin];
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "openai/gpt-4o", selection: orgSelection }],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));

    // The saved org selection checks the org row only.
    expect(option("GPT-4o via org")).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Free models" }));
    const hostedRow = option(/^GPT-4o$/);
    expect(hostedRow).toHaveAttribute("aria-checked", "false");

    // Picking the hosted twin swaps the saved selection; the id stays one
    // choice.
    await user.click(hostedRow);
    expect(onChange).toHaveBeenLastCalledWith({
      includeClientDefaults: false,
      explicitTargets: [
        {
          modelId: "openai/gpt-4o",
          selection: expect.objectContaining({ source: "hosted" }),
        },
      ],
    });
  });

  it("keeps two efforts of the id as two targets when the row is swapped", async () => {
    mockModels.availableModels = [hosted, orgTwin];
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: false,
      explicitTargets: [
        {
          modelId: "openai/gpt-4o",
          selection: { ...orgSelection, settings: { reasoningEffort: "low" } },
        },
        {
          modelId: "openai/gpt-4o",
          selection: { ...orgSelection, settings: { reasoningEffort: "high" } },
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    await user.click(screen.getByRole("button", { name: "Free models" }));
    await user.click(option(/^GPT-4o$/));

    const last = onChange.mock.calls.at(-1)![0];
    expect(last.explicitTargets).toEqual([
      {
        modelId: "openai/gpt-4o",
        selection: expect.objectContaining({
          source: "hosted",
          settings: { reasoningEffort: "low" },
        }),
      },
      {
        modelId: "openai/gpt-4o",
        selection: expect.objectContaining({
          source: "hosted",
          settings: { reasoningEffort: "high" },
        }),
      },
    ]);
  });

  it("reads a legacy id with no selection as the hosted row", async () => {
    mockModels.availableModels = [hosted, orgTwin];
    const user = userEvent.setup();
    renderPill({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "openai/gpt-4o" }],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option(/^GPT-4o$/)).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Your providers" }));
    expect(option("GPT-4o via org")).toHaveAttribute("aria-checked", "false");
  });

  it("toggles Client defaults and keeps the menu open", async () => {
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitTargets: [{ modelId: "google/gemini-2.5-flash" }],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    await user.click(option("Client defaults"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeClientDefaults: false,
        explicitTargets: [
          expect.objectContaining({ modelId: "google/gemini-2.5-flash" }),
        ],
      })
    );
    expect(screen.getByPlaceholderText("Search models")).toBeInTheDocument();
  });

  it("applies the eval target workload: a tool-less model cannot be added", async () => {
    mockModels.availableModels = [
      ...DEFAULT_MODELS,
      {
        id: "openai/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        hosted: true,
        catalogObservedAt: 1_790_000_000_000,
        observations: {
          tools: { status: "unsupported", source: "gateway-catalog" },
        },
      },
    ];
    const user = userEvent.setup();
    const onChange = renderPill({
      includeClientDefaults: true,
      explicitTargets: [],
    });
    await user.click(screen.getByRole("button", { name: "Models" }));
    const luna = option("GPT-5.6 Luna");
    expect(luna).toHaveAttribute("aria-disabled", "true");
    await user.click(luna);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ModelsPill — harness × model support", () => {
  const HARNESS_MODELS = [
    {
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      hosted: true,
    },
    {
      id: "anthropic/claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      hosted: true,
    },
    {
      id: "anthropic/claude-fable-5",
      name: "Claude Fable 5",
      provider: "anthropic",
      hosted: true,
    },
  ];

  it("disables, with the reason, a model the client's harness cannot run", async () => {
    mockModels.availableModels = [...DEFAULT_MODELS, ...HARNESS_MODELS];
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      { harnessTargets: [{ harnessId: "claude-code" }] }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    // Claude Code only runs Anthropic models.
    const luna = option("GPT-5.6 Luna");
    expect(luna).toHaveAttribute("aria-disabled", "true");
    await user.hover(luna);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "the Claude Code harness can't run this host's model"
    );
    // Not verified on the pinned runtime ⇒ refused for an eval.
    expect(option("Claude Fable 5")).toHaveAttribute("aria-disabled", "true");
    // Supported stays pickable.
    expect(option("Claude Sonnet 4.5")).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("keeps a model pickable when some selected client can run it", async () => {
    mockModels.availableModels = [...DEFAULT_MODELS, ...HARNESS_MODELS];
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      // An emulated client runs anything; the Codex cell is skipped at
      // resolve time instead.
      { harnessTargets: [{ harnessId: "codex" }, null] }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option("GPT-5.6 Luna")).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("allows an unverified pair where the purpose is chat", async () => {
    mockModels.availableModels = [...DEFAULT_MODELS, ...HARNESS_MODELS];
    const user = userEvent.setup();
    renderPill(
      { includeClientDefaults: true, explicitTargets: [] },
      { harnessTargets: [{ harnessId: "claude-code" }], purpose: "chat" }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(option("Claude Fable 5")).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(option("GPT-5.6 Luna")).toHaveAttribute("aria-disabled", "true");
  });

  it("lets the user remove a persisted pick the harness now refuses", async () => {
    mockModels.availableModels = [...DEFAULT_MODELS, ...HARNESS_MODELS];
    const user = userEvent.setup();
    const onChange = renderPill(
      { includeClientDefaults: true, explicitTargets: [{ modelId: "openai/gpt-5.6-luna" }] },
      { harnessTargets: [{ harnessId: "claude-code" }] }
    );
    await user.click(screen.getByRole("button", { name: "Models" }));
    const luna = option("GPT-5.6 Luna");
    expect(luna).toHaveAttribute("aria-checked", "true");
    expect(luna).not.toHaveAttribute("aria-disabled", "true");
    await user.click(luna);
    expect(onChange).toHaveBeenCalledWith({
      includeClientDefaults: true,
      explicitTargets: [],
    });
  });
});

describe("ModelsPill — reasoning effort", () => {
  const GPT5 = {
    id: "openai/gpt-5",
    name: "GPT-5",
    provider: "openai",
    hosted: true,
    supportedReasoningEfforts: ["low", "high"],
  };
  const BYOK = {
    id: "gpt-5",
    name: "GPT-5 (own key)",
    provider: "openai",
    hosted: false,
    supportedReasoningEfforts: undefined,
  };

  const hostedAt = (effort?: "low" | "high") => ({
    modelId: "openai/gpt-5",
    selection: {
      modelId: "openai/gpt-5",
      source: "hosted" as const,
      fallback: { provider: "none" as const, model: "none" as const },
      ...(effort ? { settings: { reasoningEffort: effort } } : {}),
    },
  });
  const efforts = (value: ModelSelection) =>
    value.explicitTargets.map((t) => t.selection?.settings?.reasoningEffort);
  /** Open the pill, then GPT-5's efforts to the side. */
  async function openEfforts() {
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await userEvent.click(await screen.findByRole("option", { name: /GPT-5/ }));
    return within(await screen.findByTestId("model-effort-menu"));
  }

  it("ticks a second effort of a picked model as its own target", async () => {
    mockModels.availableModels = [GPT5];
    const onChange = renderPill({
      includeClientDefaults: false,
      explicitTargets: [hostedAt()],
    } as ModelSelection);
    const menu = await openEfforts();
    expect(
      menu.getByRole("menuitemcheckbox", { name: "Default" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(menu.getByRole("menuitemcheckbox", { name: "High" }));
    const next = onChange.mock.calls.at(-1)![0] as ModelSelection;
    expect(next.explicitTargets.map((t) => t.modelId)).toEqual([
      "openai/gpt-5",
      "openai/gpt-5",
    ]);
    expect(efforts(next)).toEqual([undefined, "high"]);
  });

  it("keeps two efforts of one model as two targets, and unticks one alone", async () => {
    mockModels.availableModels = [GPT5];
    const onChange = renderPill({
      includeClientDefaults: false,
      explicitTargets: [hostedAt("low"), hostedAt("high")],
    } as ModelSelection);
    expect(screen.getByRole("button", { name: "Models" })).toHaveTextContent(
      "2 models",
    );
    const menu = await openEfforts();
    await userEvent.click(menu.getByRole("menuitemcheckbox", { name: "Low" }));
    const next = onChange.mock.calls.at(-1)![0] as ModelSelection;
    expect(efforts(next)).toEqual(["high"]);
  });

  it("offers a Claude Code target no level (its adapter verifies none), but a Codex target its own", async () => {
    mockModels.availableModels = [
      { ...GPT5, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
    ];
    const value = {
      includeClientDefaults: false,
      explicitTargets: [hostedAt()],
    } as ModelSelection;
    const { unmount } = render(
      <ModelsPill
        projectId="proj-1"
        value={value}
        onChange={vi.fn()}
        mode="multiple"
        testId="models"
        harnessTargets={[{ harnessId: "claude-code" }]}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await userEvent.hover(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(screen.queryByTestId("model-effort-menu")).toBeNull();
    unmount();
    render(
      <ModelsPill
        projectId="proj-1"
        value={value}
        onChange={vi.fn()}
        mode="multiple"
        testId="models"
        harnessTargets={[{ harnessId: "codex" }]}
      />
    );
    const menu = await openEfforts();
    expect(
      menu.getByRole("menuitemcheckbox", { name: "X-High" }),
    ).toBeInTheDocument();
    expect(menu.queryByRole("menuitemcheckbox", { name: "Max" })).toBeNull();
  });

  it("offers no efforts for a model with no known capability", async () => {
    mockModels.availableModels = [{ ...GPT5, supportedReasoningEfforts: [] }];
    renderPill({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "openai/gpt-5" }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await userEvent.hover(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(screen.queryByTestId("model-effort-menu")).toBeNull();
  });

  it("offers no efforts for a bare-id BYOK row (no saveable selection)", async () => {
    mockModels.availableModels = [
      { ...BYOK, supportedReasoningEfforts: ["low", "high"] },
    ];
    renderPill({
      includeClientDefaults: false,
      explicitTargets: [{ modelId: "gpt-5" }],
    });
    await userEvent.click(screen.getByRole("button", { name: "Models" }));
    await userEvent.hover(await screen.findByRole("option", { name: /GPT-5/ }));
    expect(screen.queryByTestId("model-effort-menu")).toBeNull();
  });
});

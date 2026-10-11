import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { OrgAiConfig, OrgAiModelEntry } from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { OrganizationDefaultModelCard } from "../OrganizationDefaultModelCard";

const mocks = vi.hoisted(() => ({
  setAiModel: vi.fn(),
  testAiModel: vi.fn(),
}));

let hookState: {
  config: OrgAiConfig | null | undefined;
  isLoading: boolean;
  unsupported: boolean;
  error: string | null;
  isSaving: boolean;
  testError: string | null;
  isTesting: boolean;
};

vi.mock("@/hooks/useOrgAiConfig", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useOrgAiConfig")>();
  return {
    ...actual,
    useOrgAiConfig: () => ({
      ...hookState,
      setRequireOrgKeys: vi.fn(),
      setAiModel: mocks.setAiModel,
      testAiModel: mocks.testAiModel,
    }),
  };
});

const PROVIDERS: OrgModelProvider[] = [
  { id: "conn_openai", providerKey: "openai", enabled: true, hasSecret: true },
  {
    id: "conn_anthropic",
    providerKey: "anthropic",
    enabled: true,
    hasSecret: true,
  },
  {
    id: "conn_router",
    providerKey: "openrouter",
    enabled: true,
    hasSecret: true,
  },
];

function orgSelection(
  connectionId: string,
  modelId: string,
  nativeModelId: string,
): ModelSelection {
  return {
    modelId,
    source: "org",
    connectionRef: { kind: "orgProvider", id: connectionId },
    nativeModelId,
    fallback: { provider: "none", model: "none" },
  };
}

const DEFAULT_MODEL = orgSelection(
  "conn_openai",
  "openai/gpt-5-mini",
  "gpt-5-mini",
);
const EMBEDDING = orgSelection(
  "conn_openai",
  "openai/text-embedding-3-small",
  "text-embedding-3-small",
);

function saved(
  selection: ModelSelection,
  overrides: Partial<OrgAiModelEntry> = {},
): OrgAiModelEntry {
  return {
    selection,
    label: selection.modelId,
    check: null,
    problem: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OrgAiConfig> = {}): OrgAiConfig {
  return {
    organizationId: "org-1",
    aiKeyPolicy: { requireOrgKeys: true, revision: 2 },
    readiness: {
      requireOrgKeys: true,
      features: [],
      operations: [],
      eligibleConnectionIds: ["conn_openai", "conn_anthropic"],
    },
    canEnable: true,
    canManage: true,
    supportedModelKinds: ["default"],
    aiModels: { default: null },
    ...overrides,
  };
}

function renderCard(
  props: { isAdmin?: boolean; providers?: OrgModelProvider[] } = {},
) {
  return render(
    <OrganizationDefaultModelCard
      organizationId="org-1"
      isAdmin={props.isAdmin ?? true}
      providers={props.providers ?? PROVIDERS}
    />,
  );
}

beforeEach(() => {
  mocks.setAiModel.mockReset().mockResolvedValue(undefined);
  mocks.testAiModel.mockReset().mockResolvedValue(undefined);
  hookState = {
    config: makeConfig(),
    isLoading: false,
    unsupported: false,
    error: null,
    isSaving: false,
    testError: null,
    isTesting: false,
  };
});

describe("OrganizationDefaultModelCard", () => {
  it("shows one row per kind the backend supports, with no roles", () => {
    renderCard();

    // With one kind the card's heading and the row's label read the same.
    expect(
      screen.getByRole("heading", { name: "Default AI model" }),
    ).toBeInTheDocument();
    const row = screen.getByTestId("org-ai-model-default");
    expect(within(row).getByText("Default AI model")).toBeInTheDocument();
    expect(
      within(row).getByText(
        "Insights and findings, generation, typed decisions and simulated users",
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("Not set")).toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-model-embedding"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Fast|Smart|role/)).not.toBeInTheDocument();
  });

  it("renders a row for each kind a newer backend adds, and skips unknown ones", () => {
    hookState.config = makeConfig({
      supportedModelKinds: ["default", "embedding", "transcription", "video"],
      aiModels: { default: null, embedding: null, transcription: null },
    });
    renderCard();

    expect(screen.getByText("Default AI models")).toBeInTheDocument();
    for (const kind of ["default", "embedding", "transcription"]) {
      expect(screen.getByTestId(`org-ai-model-${kind}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("org-ai-model-video")).not.toBeInTheDocument();
  });

  it.each([
    ["supportedModelKinds", { supportedModelKinds: undefined }],
    ["aiModels", { aiModels: undefined }],
  ])(
    "renders nothing on a backend without %s",
    (_label, overrides: Partial<OrgAiConfig>) => {
      hookState.config = makeConfig(overrides);
      const { container } = renderCard();

      expect(container).toBeEmptyDOMElement();
    },
  );

  it("renders nothing while loading or when the config is unsupported", () => {
    hookState.config = undefined;
    const { container, rerender } = renderCard();
    expect(container).toBeEmptyDOMElement();

    hookState.config = makeConfig();
    hookState.unsupported = true;
    rerender(
      <OrganizationDefaultModelCard
        organizationId="org-1"
        isAdmin
        providers={PROVIDERS}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the saved model, its connection and its last test", () => {
    hookState.config = makeConfig({
      aiModels: {
        default: saved(DEFAULT_MODEL, {
          label: "GPT-5 mini",
          check: { ok: true, checkedAt: Date.now() - 5 * 60 * 1000 },
        }),
      },
    });
    renderCard();

    const row = screen.getByTestId("org-ai-model-default");
    expect(within(row).getByText("OpenAI · GPT-5 mini")).toBeInTheDocument();
    expect(within(row).getByText("Last test")).toBeInTheDocument();
    expect(within(row).getByText("Passed")).toBeInTheDocument();
    expect(within(row).getByText(/5 minutes ago/)).toBeInTheDocument();
  });

  it("says a saved model was never tested", () => {
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    renderCard();

    expect(
      within(screen.getByTestId("org-ai-model-default")).getByText(
        "Not tested yet",
      ),
    ).toBeInTheDocument();
  });

  it("tests the saved model", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Test default AI model" }),
    );

    expect(mocks.testAiModel).toHaveBeenCalledWith("default", undefined);
    expect(mocks.setAiModel).not.toHaveBeenCalled();
  });

  it("shows a failed test's result", () => {
    hookState.config = makeConfig({
      aiModels: {
        default: saved(DEFAULT_MODEL, {
          check: {
            ok: false,
            code: "provider_auth_failed",
            checkedAt: Date.now(),
          },
        }),
      },
    });
    renderCard();

    expect(
      within(screen.getByTestId("org-ai-model-default")).getByText(
        "Credentials rejected",
      ),
    ).toBeInTheDocument();
  });

  it("keeps a saved model that can't run, with the backend's reason, and never reselects one", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModels: {
        default: saved(orgSelection("conn_gone", "openai/gpt-5", "gpt-5"), {
          problem: {
            code: "credential_missing",
            message:
              "The organization provider connection this default names is no longer available.",
          },
        }),
      },
    });
    renderCard();

    const row = screen.getByTestId("org-ai-model-default");
    expect(
      within(row).getByText(
        "The organization provider connection this default names is no longer available.",
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("openai/gpt-5")).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Test default AI model" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(row).getByRole("button", { name: "Change default AI model" }),
    );
    const editor = screen.getByTestId("org-ai-model-default-editor");
    expect(
      within(editor).getByRole("combobox", {
        name: "Default AI model provider",
      }),
    ).toHaveTextContent("Choose a provider");
    expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.setAiModel).not.toHaveBeenCalled();
  });

  it("shows a suggestion without saving it until clicked", async () => {
    const user = userEvent.setup();
    const suggestion = orgSelection(
      "conn_anthropic",
      "anthropic/claude-sonnet-4.5",
      "claude-sonnet-4-5",
    );
    hookState.config = makeConfig({
      aiModelSuggestions: { default: suggestion },
    });
    renderCard();

    const row = screen.getByTestId("org-ai-model-default");
    expect(
      within(row).getByText(
        /Suggested: Anthropic · anthropic\/claude-sonnet-4\.5/,
      ),
    ).toBeInTheDocument();
    expect(mocks.setAiModel).not.toHaveBeenCalled();

    await user.click(
      within(row).getByRole("button", { name: "Use suggested model" }),
    );

    expect(mocks.setAiModel).toHaveBeenCalledTimes(1);
    expect(mocks.setAiModel).toHaveBeenCalledWith("default", suggestion);
  });

  it("never offers a suggestion over a saved model", () => {
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
      aiModelSuggestions: {
        default: orgSelection(
          "conn_anthropic",
          "anthropic/claude-sonnet-4.5",
          "claude-sonnet-4-5",
        ),
      },
    });
    renderCard();

    expect(screen.queryByText(/Suggested:/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use suggested model" }),
    ).not.toBeInTheDocument();
  });

  it("builds an org selection from an eligible connection and a typed model", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Set default AI model" }),
    );
    const editor = screen.getByTestId("org-ai-model-default-editor");
    expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(
      within(editor).getByRole("combobox", {
        name: "Default AI model provider",
      }),
    );
    // Only eligible connections are offered: no OpenRouter.
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Anthropic" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "OpenRouter" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Anthropic" }));

    await user.type(
      within(editor).getByLabelText("Default AI model id"),
      "claude-haiku-4-5",
    );
    expect(
      within(editor).getByText("Saved as anthropic/claude-haiku-4.5"),
    ).toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Save" }));

    expect(mocks.setAiModel).toHaveBeenCalledWith(
      "default",
      orgSelection(
        "conn_anthropic",
        "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5",
      ),
    );
  });

  it("offers only connections that can run the kind", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      supportedModelKinds: ["default", "embedding"],
      aiModels: { default: null, embedding: null },
    });
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Set embedding model" }),
    );
    const editor = screen.getByTestId("org-ai-model-embedding-editor");
    await user.click(
      within(editor).getByRole("combobox", {
        name: "Embedding model provider",
      }),
    );
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeInTheDocument();
    // Anthropic has no embedding model.
    expect(
      screen.queryByRole("option", { name: "Anthropic" }),
    ).not.toBeInTheDocument();
  });

  it("tests a candidate before it is saved", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    mocks.testAiModel.mockResolvedValue({ ok: true, checkedAt: Date.now() });
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Change default AI model" }),
    );
    const editor = screen.getByTestId("org-ai-model-default-editor");
    const model = within(editor).getByLabelText("Default AI model id");
    await user.clear(model);
    await user.type(model, "gpt-5.1");
    await user.click(
      within(editor).getByRole("button", {
        name: "Test this default AI model",
      }),
    );

    expect(mocks.testAiModel).toHaveBeenCalledWith(
      "default",
      orgSelection("conn_openai", "openai/gpt-5.1", "gpt-5.1"),
    );
    expect(
      await within(editor).findByTestId(
        "org-ai-model-default-candidate-outcome",
      ),
    ).toHaveTextContent("Passed");
    expect(mocks.setAiModel).not.toHaveBeenCalled();
  });

  it("clears the model by saving null", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Clear default AI model" }),
    );

    expect(mocks.setAiModel).toHaveBeenCalledWith("default", null);
  });

  it("confirms an embedding change before saving it", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      supportedModelKinds: ["default", "embedding"],
      aiModels: { default: null, embedding: saved(EMBEDDING) },
    });
    renderCard();

    await user.click(
      screen.getByRole("button", { name: "Clear embedding model" }),
    );
    expect(mocks.setAiModel).not.toHaveBeenCalled();
    expect(screen.getByTestId("org-ai-embedding-confirm")).toHaveTextContent(
      /only compare vectors made by the same embedding model/,
    );

    await user.click(
      within(screen.getByTestId("org-ai-embedding-confirm")).getByRole(
        "button",
        { name: "Change embedding model" },
      ),
    );
    expect(mocks.setAiModel).toHaveBeenCalledWith("embedding", null);
  });

  it("is read-only for members", () => {
    hookState.config = makeConfig({
      canManage: false,
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    renderCard({ isAdmin: false });

    expect(
      within(screen.getByTestId("org-ai-model-default")).getByText(
        "OpenAI · openai/gpt-5-mini",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Only organization owners and admins can change this."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Test|Change|Set|Clear) / }),
    ).not.toBeInTheDocument();
  });

  it("defers to the backend when it says the viewer cannot manage", () => {
    hookState.config = makeConfig({
      canManage: false,
      aiModelSuggestions: { default: DEFAULT_MODEL },
    });
    renderCard({ isAdmin: true });

    expect(
      screen.queryByRole("button", { name: "Set default AI model" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Suggested:/)).not.toBeInTheDocument();
  });

  describe("Enterprise only", () => {
    it("greys the choice out when the backend says the org can't use it", () => {
      hookState.config = makeConfig({
        canEnable: false,
        aiModelSuggestions: { default: DEFAULT_MODEL },
      });
      renderCard();

      expect(
        screen.getByTestId("org-ai-default-model-enterprise-badge"),
      ).toHaveTextContent("Enterprise");
      expect(
        screen.getByTestId("org-ai-default-model-enterprise-only"),
      ).toHaveTextContent("Available on Enterprise plans.");
      expect(screen.getByTestId("org-ai-model-default")).toHaveClass(
        "opacity-60",
      );
      expect(
        screen.queryByRole("button", { name: "Set default AI model" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Use suggested model" }),
      ).not.toBeInTheDocument();
    });

    it("keeps a saved model visible and clearable after the org left Enterprise", async () => {
      const user = userEvent.setup();
      hookState.config = makeConfig({
        canEnable: false,
        aiModels: { default: saved(DEFAULT_MODEL) },
      });
      renderCard();

      const row = screen.getByTestId("org-ai-model-default");
      expect(row).not.toHaveClass("opacity-60");
      expect(
        within(row).getByText("OpenAI · openai/gpt-5-mini"),
      ).toBeInTheDocument();
      expect(
        within(row).queryByRole("button", { name: "Change default AI model" }),
      ).not.toBeInTheDocument();
      expect(
        within(row).queryByRole("button", { name: "Test default AI model" }),
      ).not.toBeInTheDocument();

      await user.click(
        within(row).getByRole("button", { name: "Clear default AI model" }),
      );
      expect(mocks.setAiModel).toHaveBeenCalledWith("default", null);
    });

    it("never reads the plan anywhere but the backend's answer", () => {
      hookState.config = makeConfig({ canEnable: true });
      renderCard();

      expect(
        screen.queryByTestId("org-ai-default-model-enterprise-badge"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Set default AI model" }),
      ).toBeInTheDocument();
    });
  });

  it("says what the model does with the policy off", () => {
    hookState.config = makeConfig({
      aiKeyPolicy: { requireOrgKeys: false, revision: 1 },
    });
    renderCard();

    expect(
      screen.getByText(/Until then, MCPJam-provided models run it\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Model pickers never use it, and each suite still chooses its own judge\./,
      ),
    ).toBeInTheDocument();
  });

  it("shows why the last save or test failed", () => {
    hookState.error =
      "Choosing a default model is available on Enterprise plans.";
    hookState.testError = "Not authorized for organization AI settings";
    renderCard();

    expect(screen.getByTestId("org-ai-default-model-error")).toHaveTextContent(
      "Choosing a default model is available on Enterprise plans.",
    );
    expect(
      screen.getByTestId("org-ai-default-model-test-error"),
    ).toHaveTextContent("Not authorized for organization AI settings");
  });
});

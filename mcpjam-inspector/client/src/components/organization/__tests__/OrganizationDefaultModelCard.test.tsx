import { render, screen, within } from "@testing-library/react";
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
      providers={"providers" in props ? props.providers : PROVIDERS}
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

  it("displays an admin's suggestion without saving it implicitly", () => {
    hookState.config = makeConfig({
      aiModelSuggestions: { default: DEFAULT_MODEL },
    });
    renderCard();
    expect(screen.getByText(/Suggested model/)).toBeInTheDocument();
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

    expect(screen.queryByText(/Suggested model/)).not.toBeInTheDocument();
  });

  it("shows the saved model to members", () => {
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
  });

  it("defers to the backend when it says the viewer cannot manage", () => {
    hookState.config = makeConfig({
      canManage: false,
      aiModelSuggestions: { default: DEFAULT_MODEL },
    });
    renderCard({ isAdmin: true });

    expect(screen.queryByText(/Suggested model/)).not.toBeInTheDocument();
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
  it("waits for provider metadata before identifying a removed connection", () => {
    hookState.config = makeConfig({
      aiModels: { default: saved(DEFAULT_MODEL) },
    });
    const { rerender } = renderCard({ providers: undefined });
    expect(screen.getByText("openai/gpt-5-mini")).toBeInTheDocument();
    expect(screen.queryByText(/conn_openai/)).not.toBeInTheDocument();

    rerender(
      <OrganizationDefaultModelCard
        organizationId="org-1"
        isAdmin
        providers={[]}
      />,
    );
    expect(
      screen.getByText("conn_openai · openai/gpt-5-mini"),
    ).toBeInTheDocument();

    rerender(
      <OrganizationDefaultModelCard
        organizationId="org-1"
        isAdmin
        providers={PROVIDERS}
      />,
    );
    expect(screen.getByText("OpenAI · openai/gpt-5-mini")).toBeInTheDocument();
    expect(screen.queryByText(/conn_openai/)).not.toBeInTheDocument();
  });

  it("names the missing default model when the key policy is on", () => {
    renderCard();
    expect(
      screen.getByText(/With no default model set, that work is unavailable\./),
    ).toBeInTheDocument();
  });
});

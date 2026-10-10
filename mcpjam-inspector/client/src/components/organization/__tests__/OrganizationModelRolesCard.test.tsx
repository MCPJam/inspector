import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { OrgAiConfig } from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { OrganizationModelRolesCard } from "../OrganizationModelRolesCard";

const mocks = vi.hoisted(() => ({
  saveRoles: vi.fn(),
  testRole: vi.fn(),
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
      saveRoles: mocks.saveRoles,
      testRole: mocks.testRole,
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

const FAST = orgSelection("conn_openai", "openai/gpt-5-mini", "gpt-5-mini");
const SMART = orgSelection("conn_openai", "openai/gpt-5", "gpt-5");
const EMBEDDING = orgSelection(
  "conn_openai",
  "openai/text-embedding-3-small",
  "text-embedding-3-small",
);

function makeConfig(overrides: Partial<OrgAiConfig> = {}): OrgAiConfig {
  return {
    organizationId: "org-1",
    aiKeyPolicy: { requireOrgKeys: true, revision: 2 },
    aiModelRoles: { revision: 3 },
    aiModelRoleChecks: [],
    readiness: {
      requireOrgKeys: true,
      features: [],
      operations: [],
      eligibleConnectionIds: ["conn_openai", "conn_anthropic"],
    },
    canManage: true,
    ...overrides,
  };
}

function renderCard(
  props: { isAdmin?: boolean; providers?: OrgModelProvider[] } = {},
) {
  return render(
    <OrganizationModelRolesCard
      organizationId="org-1"
      isAdmin={props.isAdmin ?? true}
      providers={props.providers ?? PROVIDERS}
    />,
  );
}

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Advanced" }));
}

beforeEach(() => {
  mocks.saveRoles.mockReset().mockResolvedValue({ revision: 4, changed: [] });
  mocks.testRole.mockReset().mockResolvedValue(undefined);
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

describe("OrganizationModelRolesCard", () => {
  it("keeps the roles behind an Advanced disclosure", async () => {
    const user = userEvent.setup();
    renderCard();

    expect(screen.queryByTestId("org-ai-role-fast")).not.toBeInTheDocument();
    await openAdvanced(user);

    expect(screen.getByText("Default model roles")).toBeInTheDocument();
    for (const [role, features] of [
      ["fast", "Typed decisions, titles, classification"],
      ["smart", "Analysis, generation, simulated users"],
      ["embedding", "Session map, clustering"],
      ["transcription", "Voice input"],
    ] as const) {
      expect(
        within(screen.getByTestId(`org-ai-role-${role}`)).getByText(features),
      ).toBeInTheDocument();
    }
  });

  it("shows each saved role's connection, model and its own last test", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, fast: FAST, smart: SMART },
      aiModelRoleChecks: [
        {
          role: "fast",
          selectionKey: "conn_openai|openai/gpt-5-mini|gpt-5-mini",
          checkedAt: Date.now() - 5 * 60 * 1000,
          outcome: "ok",
        },
        // A check of a model the Smart role no longer points at.
        {
          role: "smart",
          selectionKey: "conn_openai|openai/gpt-4o|gpt-4o",
          checkedAt: Date.now(),
          outcome: "auth_failed",
        },
      ],
    });
    renderCard();
    await openAdvanced(user);

    const fast = screen.getByTestId("org-ai-role-fast");
    expect(
      within(fast).getByText("OpenAI · openai/gpt-5-mini"),
    ).toBeInTheDocument();
    expect(within(fast).getByText("Passed")).toBeInTheDocument();
    expect(within(fast).getByText(/5 minutes ago/)).toBeInTheDocument();

    const smart = screen.getByTestId("org-ai-role-smart");
    expect(within(smart).getByText("Not tested yet")).toBeInTheDocument();
    expect(
      within(smart).queryByText("Credentials rejected"),
    ).not.toBeInTheDocument();

    expect(
      within(screen.getByTestId("org-ai-role-embedding")).getByText("Not set"),
    ).toBeInTheDocument();
  });

  it("tests a saved role and shows the outcome", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, fast: FAST },
    });
    mocks.testRole.mockResolvedValue({
      role: "fast",
      outcome: "auth_failed",
      checkedAt: Date.now(),
    });
    renderCard();
    await openAdvanced(user);

    await user.click(screen.getByRole("button", { name: "Test Fast model" }));

    expect(mocks.testRole).toHaveBeenCalledWith("fast", undefined);
    await waitFor(() =>
      expect(
        within(screen.getByTestId("org-ai-role-fast")).getByText(
          "Credentials rejected",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("is read-only for members", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      canManage: false,
      aiModelRoles: { revision: 3, fast: FAST },
      suggestedAiModelRoles: { smart: SMART },
    });
    renderCard({ isAdmin: false });
    await openAdvanced(user);

    expect(
      within(screen.getByTestId("org-ai-role-fast")).getByText(
        "OpenAI · openai/gpt-5-mini",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Test Fast model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Change|Set|Clear) / }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use suggested defaults" }),
    ).not.toBeInTheDocument();
  });

  it("shows suggested defaults without saving them until clicked", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, fast: FAST },
      suggestedAiModelRoles: {
        // Fast is already chosen; a suggestion never overwrites it.
        fast: orgSelection(
          "conn_anthropic",
          "anthropic/claude-haiku-4.5",
          "claude-haiku-4-5",
        ),
        smart: orgSelection(
          "conn_anthropic",
          "anthropic/claude-sonnet-4.5",
          "claude-sonnet-4-5",
        ),
      },
    });
    renderCard();
    await openAdvanced(user);

    expect(
      within(screen.getByTestId("org-ai-role-smart")).getByText(
        /Suggested: Anthropic · anthropic\/claude-sonnet-4\.5/,
      ),
    ).toBeInTheDocument();
    expect(mocks.saveRoles).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Use suggested defaults" }),
    );

    expect(mocks.saveRoles).toHaveBeenCalledTimes(1);
    expect(mocks.saveRoles).toHaveBeenCalledWith({
      smart: orgSelection(
        "conn_anthropic",
        "anthropic/claude-sonnet-4.5",
        "claude-sonnet-4-5",
      ),
    });
  });

  it("confirms before suggested defaults change the embedding model", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      suggestedAiModelRoles: { fast: FAST, embedding: EMBEDDING },
    });
    renderCard();
    await openAdvanced(user);

    await user.click(
      screen.getByRole("button", { name: "Use suggested defaults" }),
    );
    expect(mocks.saveRoles).not.toHaveBeenCalled();
    expect(screen.getByTestId("org-ai-embedding-confirm")).toHaveTextContent(
      /rebuilds the session map and clustering/,
    );

    await user.click(
      screen.getByRole("button", { name: "Change embedding model" }),
    );
    expect(mocks.saveRoles).toHaveBeenCalledWith({
      fast: FAST,
      embedding: EMBEDDING,
    });
  });

  it("prefills the editor from a suggestion and saves the edited role", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      suggestedAiModelRoles: {
        fast: orgSelection(
          "conn_anthropic",
          "anthropic/claude-haiku-4.5",
          "claude-haiku-4-5",
        ),
      },
    });
    renderCard();
    await openAdvanced(user);

    await user.click(screen.getByRole("button", { name: "Set Fast model" }));
    const editor = screen.getByTestId("org-ai-role-fast-editor");
    expect(within(editor).getByLabelText("Fast model id")).toHaveValue(
      "claude-haiku-4-5",
    );
    expect(
      within(editor).getByText("Saved as anthropic/claude-haiku-4.5"),
    ).toBeInTheDocument();
    expect(mocks.saveRoles).not.toHaveBeenCalled();

    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(mocks.saveRoles).toHaveBeenCalledWith({
      fast: orgSelection(
        "conn_anthropic",
        "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5",
      ),
    });
  });

  it("builds an org selection from an eligible connection and a typed model", async () => {
    const user = userEvent.setup();
    renderCard();
    await openAdvanced(user);

    await user.click(
      screen.getByRole("button", { name: "Set Transcription model" }),
    );
    const editor = screen.getByTestId("org-ai-role-transcription-editor");
    expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(
      within(editor).getByRole("combobox", {
        name: "Transcription connection",
      }),
    );
    // Only eligible connections are offered: no OpenRouter.
    expect(screen.getByRole("option", { name: "OpenAI" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "OpenRouter" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "OpenAI" }));

    await user.type(
      within(editor).getByLabelText("Transcription model id"),
      "gpt-4o-mini-transcribe",
    );
    await user.click(within(editor).getByRole("button", { name: "Save" }));

    expect(mocks.saveRoles).toHaveBeenCalledWith({
      transcription: {
        modelId: "openai/gpt-4o-mini-transcribe",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "conn_openai" },
        nativeModelId: "gpt-4o-mini-transcribe",
        fallback: { provider: "none", model: "none" },
      },
    });
  });

  it("tests a candidate before it is saved", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, smart: SMART },
    });
    mocks.testRole.mockResolvedValue({
      role: "smart",
      outcome: "ok",
      checkedAt: Date.now(),
    });
    renderCard();
    await openAdvanced(user);

    await user.click(
      screen.getByRole("button", { name: "Change Smart model" }),
    );
    const editor = screen.getByTestId("org-ai-role-smart-editor");
    const model = within(editor).getByLabelText("Smart model id");
    await user.clear(model);
    await user.type(model, "gpt-5.1");
    await user.click(
      within(editor).getByRole("button", { name: "Test this Smart model" }),
    );

    expect(mocks.testRole).toHaveBeenCalledWith(
      "smart",
      orgSelection("conn_openai", "openai/gpt-5.1", "gpt-5.1"),
    );
    expect(
      await within(editor).findByTestId("org-ai-role-smart-candidate-outcome"),
    ).toHaveTextContent("Passed");
    expect(mocks.saveRoles).not.toHaveBeenCalled();
  });

  it("confirms an embedding change before saving it", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, embedding: EMBEDDING },
    });
    renderCard();
    await openAdvanced(user);

    await user.click(
      screen.getByRole("button", { name: "Change Embedding model" }),
    );
    const editor = screen.getByTestId("org-ai-role-embedding-editor");
    const model = within(editor).getByLabelText("Embedding model id");
    await user.clear(model);
    await user.type(model, "text-embedding-3-large");
    await user.click(within(editor).getByRole("button", { name: "Save" }));

    expect(mocks.saveRoles).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("org-ai-embedding-confirm");
    expect(dialog).toHaveTextContent(
      /Changing the embedding model rebuilds the session map and clustering with the new model\./,
    );
    expect(dialog).toHaveTextContent(/stay labelled/);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.saveRoles).not.toHaveBeenCalled();

    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await user.click(
      screen.getByRole("button", { name: "Change embedding model" }),
    );
    expect(mocks.saveRoles).toHaveBeenCalledWith({
      embedding: orgSelection(
        "conn_openai",
        "openai/text-embedding-3-large",
        "text-embedding-3-large",
      ),
    });
  });

  it("clears a role by saving null, confirming first for embedding", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: { revision: 3, fast: FAST, embedding: EMBEDDING },
    });
    renderCard();
    await openAdvanced(user);

    await user.click(screen.getByRole("button", { name: "Clear Fast model" }));
    expect(mocks.saveRoles).toHaveBeenLastCalledWith({ fast: null });

    await user.click(
      screen.getByRole("button", { name: "Clear Embedding model" }),
    );
    expect(mocks.saveRoles).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Change embedding model" }),
    );
    expect(mocks.saveRoles).toHaveBeenLastCalledWith({ embedding: null });
  });

  it("keeps a role whose connection was removed, and never reselects one", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      aiModelRoles: {
        revision: 3,
        smart: orgSelection("conn_gone", "openai/gpt-5", "gpt-5"),
      },
    });
    renderCard();

    // Opens on its own: this is the state that needs an admin.
    const smart = await screen.findByTestId("org-ai-role-smart");
    expect(
      within(smart).getByText("Connection removed: choose another"),
    ).toBeInTheDocument();
    expect(within(smart).getByText("openai/gpt-5")).toBeInTheDocument();
    expect(
      within(smart).queryByRole("button", { name: "Test Smart model" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(smart).getByRole("button", { name: "Change Smart model" }),
    );
    const editor = screen.getByTestId("org-ai-role-smart-editor");
    expect(
      within(editor).getByRole("combobox", { name: "Smart connection" }),
    ).toHaveTextContent("Choose a connection");
    expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.saveRoles).not.toHaveBeenCalled();
  });

  it("offers no editor when no eligible provider exists", async () => {
    const user = userEvent.setup();
    hookState.config = makeConfig({
      readiness: {
        requireOrgKeys: true,
        features: [],
        operations: [],
        eligibleConnectionIds: [],
      },
    });
    renderCard({ providers: [] });
    await openAdvanced(user);

    await user.click(screen.getByRole("button", { name: "Set Fast model" }));
    expect(
      screen.getByText(/No eligible organization provider is configured/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-role-fast-editor"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the backend's message when a save is refused", async () => {
    const user = userEvent.setup();
    hookState.error =
      "That connection can't serve this role while your keys are required.";
    renderCard();
    await openAdvanced(user);

    expect(screen.getByTestId("org-ai-roles-error")).toHaveTextContent(
      "That connection can't serve this role while your keys are required.",
    );
  });

  it("renders nothing on a backend that cannot report roles", () => {
    hookState = { ...hookState, config: undefined, unsupported: true };
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });
});

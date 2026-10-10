import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiFeatureGroupReadiness,
  OrgAiConfig,
} from "@/hooks/useOrgAiConfig";
import { OrganizationOrgKeysPolicyCard } from "../OrganizationOrgKeysPolicyCard";

const mockSetRequireOrgKeys = vi.fn();

let hookState: {
  config: OrgAiConfig | null | undefined;
  isLoading: boolean;
  unsupported: boolean;
  error: string | null;
  isSaving: boolean;
};

vi.mock("@/hooks/useOrgAiConfig", () => ({
  useOrgAiConfig: () => ({
    ...hookState,
    testError: null,
    isTesting: false,
    setRequireOrgKeys: mockSetRequireOrgKeys,
    saveRoles: vi.fn(),
    testRole: vi.fn(),
  }),
}));

const FEATURES_ON: AiFeatureGroupReadiness[] = [
  // Deliberately out of display order: the card sorts.
  {
    id: "ask_mcpjam",
    label: "Ask MCPJam",
    status: "unsupported",
    blockedBy: ["agent_chat"],
    degradedBy: [],
  },
  {
    id: "chat",
    label: "Chat",
    status: "ready",
    blockedBy: [],
    degradedBy: [],
  },
  {
    id: "evals",
    label: "Evals",
    status: "unconfigured",
    blockedBy: ["judge"],
    degradedBy: [],
  },
  {
    id: "insights",
    label: "Insights",
    status: "ready",
    blockedBy: [],
    degradedBy: ["embedding"],
  },
  {
    id: "generation",
    label: "Generation",
    status: "temporarily_unavailable",
    blockedBy: ["text_generation"],
    degradedBy: [],
  },
  {
    id: "harness",
    label: "Harness",
    status: "unsupported",
    blockedBy: ["harness_runtime"],
    degradedBy: [],
  },
  {
    id: "transcription",
    label: "Transcription",
    status: "invalid_credentials",
    blockedBy: ["speech_transcription"],
    degradedBy: [],
  },
];

function makeConfig(
  overrides: {
    requireOrgKeys?: boolean;
    features?: AiFeatureGroupReadiness[];
    eligibleConnectionIds?: string[];
    canManage?: boolean;
  } = {},
): OrgAiConfig {
  const requireOrgKeys = overrides.requireOrgKeys ?? false;
  return {
    organizationId: "org-1",
    aiKeyPolicy: { requireOrgKeys, revision: 1 },
    aiModelRoles: { revision: 0 },
    aiModelRoleChecks: [],
    readiness: {
      requireOrgKeys,
      features:
        overrides.features ??
        (requireOrgKeys
          ? FEATURES_ON
          : FEATURES_ON.map((f) => ({
              ...f,
              status: "hosted" as const,
              blockedBy: [],
              degradedBy: [],
            }))),
      operations: [
        { operation: "judge", status: "unconfigured" },
        { operation: "text_generation", status: "unconfigured", role: "smart" },
        { operation: "embedding", status: "unconfigured", role: "embedding" },
      ],
      eligibleConnectionIds: overrides.eligibleConnectionIds ?? ["conn_1"],
    },
    canManage: overrides.canManage ?? true,
  };
}

beforeEach(() => {
  mockSetRequireOrgKeys.mockReset().mockResolvedValue(undefined);
  hookState = {
    config: makeConfig(),
    isLoading: false,
    unsupported: false,
    error: null,
    isSaving: false,
  };
});

describe("OrganizationOrgKeysPolicyCard", () => {
  it("shows the setting off with today's behavior summarised", () => {
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByText("AI keys")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", {
      name: "Use your keys for all AI features",
    });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText(
        /AI requests must use an approved organization provider\. MCPJam-provided models are disabled\. Features without a compatible provider are unavailable\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("org-ai-keys-off-summary")).toHaveTextContent(
      "MCPJam-provided models are used where you haven't chosen an organization model.",
    );
    // Coverage is about the policy; off, it would only list "MCPJam-provided".
    expect(screen.queryByText("Feature coverage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("org-ai-keys-billing")).not.toBeInTheDocument();
  });

  it("lets an admin turn it on", async () => {
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-ai-keys-toggle"));

    await waitFor(() =>
      expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(true),
    );
  });

  it("lets an admin turn it back off", async () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const toggle = screen.getByTestId("org-ai-keys-toggle");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(false),
    );
  });

  it("can be turned on with zero providers configured", async () => {
    hookState.config = makeConfig({ eligibleConnectionIds: [] });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-ai-keys-toggle"));
    await waitFor(() =>
      expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(true),
    );
  });

  it("says when no eligible provider exists while it is on", () => {
    hookState.config = makeConfig({
      requireOrgKeys: true,
      eligibleConnectionIds: [],
    });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(
      screen.getByTestId("org-ai-keys-no-eligible-provider"),
    ).toHaveTextContent(/OpenRouter and local providers don't qualify/);
  });

  it("discloses billing and lists feature coverage while it is on", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-ai-keys-billing")).toHaveTextContent(
      "Model tokens are billed by your providers. MCPJam product fees and usage limits still apply.",
    );
    expect(screen.getByText("Feature coverage")).toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-keys-off-summary"),
    ).not.toBeInTheDocument();

    // Display order, with the client's names for each group.
    const rows = screen.getAllByTestId(/^org-ai-feature-[a-z_]+$/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "org-ai-feature-chat",
      "org-ai-feature-evals",
      "org-ai-feature-insights",
      "org-ai-feature-generation",
      "org-ai-feature-harness",
      "org-ai-feature-transcription",
      "org-ai-feature-ask_mcpjam",
    ]);
    expect(
      within(screen.getByTestId("org-ai-feature-evals")).getByText(
        "Evals and grading",
      ),
    ).toBeInTheDocument();

    expect(screen.getByTestId("org-ai-feature-status-chat")).toHaveTextContent(
      "Ready",
    );
    expect(screen.getByTestId("org-ai-feature-status-evals")).toHaveTextContent(
      "Unavailable",
    );
    expect(
      screen.getByTestId("org-ai-feature-status-harness"),
    ).toHaveTextContent("Not supported yet");
    expect(
      screen.getByTestId("org-ai-feature-status-transcription"),
    ).toHaveTextContent("Invalid credentials");
    expect(
      screen.getByTestId("org-ai-feature-status-generation"),
    ).toHaveTextContent("Temporarily unavailable");
  });

  it("names the operation that blocks a feature and what an admin can do", () => {
    hookState.config = makeConfig({
      requireOrgKeys: true,
      eligibleConnectionIds: [],
    });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    // No eligible provider: adding one is the fix.
    const evals = screen.getByTestId("org-ai-feature-evals");
    expect(
      within(evals).getByText("Add or configure an organization provider."),
    ).toBeInTheDocument();
    expect(within(evals).getByText("Blocked by grading")).toBeInTheDocument();
  });

  it("points at Default model roles when a provider exists and a role model is the fix", () => {
    hookState.config = makeConfig({
      requireOrgKeys: true,
      features: [
        {
          id: "generation",
          label: "Generation",
          status: "unconfigured",
          blockedBy: ["text_generation"],
          degradedBy: [],
        },
      ],
    });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const generation = screen.getByTestId("org-ai-feature-generation");
    expect(
      within(generation).getByText(
        "Choose the organization's Smart model in Default model roles.",
      ),
    ).toBeInTheDocument();
    expect(
      within(generation).queryByText(/Add or configure/),
    ).not.toBeInTheDocument();
    expect(
      within(generation).getByText("Blocked by text generation (Smart model)"),
    ).toBeInTheDocument();
  });

  it("says nothing more when the only blocker is the feature itself", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    for (const id of ["ask_mcpjam", "harness", "transcription"]) {
      expect(
        within(screen.getByTestId(`org-ai-feature-${id}`)).queryByText(
          /Blocked by/,
        ),
      ).not.toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId("org-ai-feature-ask_mcpjam")).getByText(
        "This feature can't run on organization providers yet.",
      ),
    ).toBeInTheDocument();
  });

  it("says what still runs when an optional operation is missing", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const insights = screen.getByTestId("org-ai-feature-insights");
    expect(
      within(insights).getByText(
        "Session map unavailable; text insights still run",
      ),
    ).toBeInTheDocument();
    // Text insights never read as needing embeddings.
    expect(within(insights).queryByText(/Blocked by/)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("org-ai-feature-status-insights"),
    ).toHaveTextContent("Ready");
  });

  it("is read-only for someone who is not an owner or admin", () => {
    hookState.config = makeConfig({ requireOrgKeys: true, canManage: false });
    render(
      <OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin={false} />,
    );

    expect(screen.getByTestId("org-ai-keys-toggle")).toBeDisabled();
    expect(
      screen.getByText("Only organization owners and admins can change this."),
    ).toBeInTheDocument();
    // Members are pointed at an admin, not at settings they cannot change.
    expect(
      within(screen.getByTestId("org-ai-feature-evals")).getByText(
        "Ask an organization admin to add or configure an organization provider.",
      ),
    ).toBeInTheDocument();
  });

  it("defers to the backend when it says the viewer cannot manage", () => {
    hookState.config = makeConfig({ canManage: false });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-ai-keys-toggle")).toBeDisabled();
  });

  it("shows no switch until the current setting has loaded", () => {
    hookState = { ...hookState, config: undefined, isLoading: true };
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    // Never an unchecked switch for a value nobody knows yet.
    expect(screen.queryByTestId("org-ai-keys-toggle")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("org-ai-keys-toggle-loading"),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-keys-off-summary"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing on a backend that cannot report the setting", () => {
    hookState = { ...hookState, config: undefined, unsupported: true };
    const { container } = render(
      <OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the backend has no config for the viewer", () => {
    hookState = { ...hookState, config: null };
    const { container } = render(
      <OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows why the last save failed", () => {
    hookState = {
      ...hookState,
      error: "Only organization owners and admins can change this setting.",
    };
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-ai-keys-error")).toHaveTextContent(
      "Only organization owners and admins can change this setting.",
    );
  });
});

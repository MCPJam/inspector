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
    setRequireOrgKeys: mockSetRequireOrgKeys,
  }),
}));

// The go-live coverage: the eval workflow and the harness runtimes run on org
// keys, background AI waits for a later release.
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
    status: "ready",
    blockedBy: [],
    degradedBy: ["text_analysis"],
  },
  {
    id: "insights",
    label: "Insights",
    status: "unsupported",
    blockedBy: ["text_analysis"],
    degradedBy: ["typed_decision", "embedding"],
  },
  {
    id: "generation",
    label: "Generation",
    status: "unsupported",
    blockedBy: ["text_generation"],
    degradedBy: [],
  },
  {
    id: "session_map",
    label: "Session map",
    status: "unsupported",
    blockedBy: ["embedding"],
    degradedBy: [],
  },
  {
    id: "harness",
    label: "Harness",
    status: "ready",
    blockedBy: [],
    degradedBy: [],
  },
  {
    id: "transcription",
    label: "Transcription",
    status: "unsupported",
    blockedBy: ["speech_transcription"],
    degradedBy: [],
  },
];

const NO_PROVIDER_FEATURES: AiFeatureGroupReadiness[] = [
  {
    id: "chat",
    label: "Chat",
    status: "unconfigured",
    blockedBy: ["chat"],
    degradedBy: [],
  },
  {
    id: "evals",
    label: "Evals",
    status: "unconfigured",
    blockedBy: ["eval_target", "judge"],
    degradedBy: [],
  },
];

function makeConfig(
  overrides: {
    requireOrgKeys?: boolean;
    features?: AiFeatureGroupReadiness[];
    eligibleConnectionIds?: string[];
    canEnable?: boolean;
    canManage?: boolean;
  } = {},
): OrgAiConfig {
  const requireOrgKeys = overrides.requireOrgKeys ?? false;
  return {
    organizationId: "org-1",
    aiKeyPolicy: { requireOrgKeys, revision: 1 },
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
        { operation: "chat", status: "ready" },
        { operation: "judge", status: "ready" },
        {
          operation: "text_analysis",
          status: "unsupported",
          code: "org_runtime_unsupported",
        },
        {
          operation: "typed_decision",
          status: "unsupported",
          code: "org_runtime_unsupported",
        },
        {
          operation: "embedding",
          status: "unsupported",
          code: "org_runtime_unsupported",
        },
      ],
      eligibleConnectionIds: overrides.eligibleConnectionIds ?? ["conn_1"],
    },
    canEnable: overrides.canEnable ?? true,
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
    expect(
      screen.queryByTestId("org-ai-keys-enterprise-badge"),
    ).not.toBeInTheDocument();
  });

  it("lets an admin turn it on without asking", async () => {
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-ai-keys-toggle"));

    await waitFor(() =>
      expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(true),
    );
    expect(
      screen.queryByTestId("org-ai-keys-confirm-off"),
    ).not.toBeInTheDocument();
  });

  it("asks before turning it off, and turns it off on confirmation", async () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const toggle = screen.getByTestId("org-ai-keys-toggle");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    const confirm = screen.getByTestId("org-ai-keys-confirm-off");
    expect(confirm).toHaveTextContent(
      "MCPJam-provided models will run on this organization's data again",
    );
    expect(confirm).toHaveTextContent("recorded in the audit log");
    expect(mockSetRequireOrgKeys).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(false),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("org-ai-keys-confirm-off"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps it on when the admin backs out", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    fireEvent.click(screen.getByTestId("org-ai-keys-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));

    expect(
      screen.queryByTestId("org-ai-keys-confirm-off"),
    ).not.toBeInTheDocument();
    expect(mockSetRequireOrgKeys).not.toHaveBeenCalled();
    expect(screen.getByTestId("org-ai-keys-toggle")).toBeChecked();
  });

  describe("Enterprise only", () => {
    it("greys the switch out when the backend says the org can't turn it on", () => {
      hookState.config = makeConfig({ canEnable: false });
      render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

      expect(screen.getByTestId("org-ai-keys-toggle")).toBeDisabled();
      expect(screen.getByTestId("org-ai-keys-setting")).toHaveClass(
        "opacity-60",
      );
      expect(
        screen.getByTestId("org-ai-keys-enterprise-badge"),
      ).toHaveTextContent("Enterprise");
      const upsell = screen.getByTestId("org-ai-keys-enterprise-only");
      expect(upsell).toHaveTextContent("Available on Enterprise plans.");
      expect(
        within(upsell).getByRole("link", { name: "Contact us" }),
      ).toHaveAttribute("href", "https://www.mcpjam.com/contact");
    });

    it("tells members why too", () => {
      hookState.config = makeConfig({ canEnable: false, canManage: false });
      render(
        <OrganizationOrgKeysPolicyCard
          organizationId="org-1"
          isAdmin={false}
        />,
      );

      expect(screen.getByTestId("org-ai-keys-toggle")).toBeDisabled();
      expect(
        screen.getByTestId("org-ai-keys-enterprise-only"),
      ).toHaveTextContent("Available on Enterprise plans.");
    });

    it("keeps the switch usable when it is already on, so an admin can turn it off", async () => {
      hookState.config = makeConfig({ requireOrgKeys: true, canEnable: false });
      render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

      const toggle = screen.getByTestId("org-ai-keys-toggle");
      expect(toggle).toBeEnabled();
      expect(toggle).toBeChecked();
      expect(
        screen.queryByTestId("org-ai-keys-enterprise-only"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("org-ai-keys-left-enterprise"),
      ).toHaveTextContent("turning it back on needs an Enterprise plan");

      fireEvent.click(toggle);
      const confirm = screen.getByTestId("org-ai-keys-confirm-off");
      expect(confirm).toHaveTextContent(
        "Turning it back on needs an Enterprise plan.",
      );
      fireEvent.click(
        within(confirm).getByRole("button", { name: "Turn off" }),
      );
      await waitFor(() =>
        expect(mockSetRequireOrgKeys).toHaveBeenCalledWith(false),
      );
    });

    it("never reads the plan anywhere but the backend's answer", () => {
      hookState.config = makeConfig({ canEnable: true });
      render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

      expect(screen.getByTestId("org-ai-keys-toggle")).toBeEnabled();
      expect(
        screen.queryByTestId("org-ai-keys-enterprise-only"),
      ).not.toBeInTheDocument();
    });
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
      "org-ai-feature-session_map",
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
      "Ready",
    );
  });

  it("asks evals for a judge choice and says what the run goes without", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const evals = screen.getByTestId("org-ai-feature-evals");
    expect(
      within(evals).getByText(
        "Choose a judge model from an organization provider for each suite. A suite without one can't run.",
      ),
    ).toBeInTheDocument();
    expect(
      within(evals).getByText(
        "Automatic findings not supported yet; runs and grading still complete",
      ),
    ).toBeInTheDocument();
  });

  it("shows features that wait for a later release as not supported yet, with no fix", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    for (const id of [
      "insights",
      "generation",
      "session_map",
      "transcription",
      "ask_mcpjam",
    ]) {
      const row = screen.getByTestId(`org-ai-feature-${id}`);
      expect(
        screen.getByTestId(`org-ai-feature-status-${id}`),
      ).toHaveTextContent("Not supported yet");
      expect(
        within(row).getByText(
          "This feature can't run on organization providers yet.",
        ),
      ).toBeInTheDocument();
      expect(within(row).queryByText(/Blocked by/)).not.toBeInTheDocument();
      // No fix: nothing to add, choose or ask an admin for.
      expect(
        within(row).queryByText(/Add a |Choose a |Ask an organization admin/),
      ).toBeNull();
    }
  });

  it("says harness runtimes run on the organization's Anthropic and OpenAI providers", () => {
    hookState.config = makeConfig({ requireOrgKeys: true });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const harness = screen.getByTestId("org-ai-feature-harness");
    expect(
      screen.getByTestId("org-ai-feature-status-harness"),
    ).toHaveTextContent("Ready");
    expect(
      within(harness).getByText(
        "Claude Code runs on an Anthropic provider and Codex on an OpenAI provider.",
      ),
    ).toBeInTheDocument();
    expect(within(harness).queryByText(/Blocked by/)).not.toBeInTheDocument();
  });

  it("names the actual fix when there is no provider", () => {
    hookState.config = makeConfig({
      requireOrgKeys: true,
      eligibleConnectionIds: [],
      features: NO_PROVIDER_FEATURES,
    });
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    const chat = screen.getByTestId("org-ai-feature-chat");
    expect(
      within(chat).getByText("Add a direct cloud provider below."),
    ).toBeInTheDocument();
    // Chat is never blocked by itself.
    expect(within(chat).queryByText(/Blocked by/)).not.toBeInTheDocument();

    const evals = screen.getByTestId("org-ai-feature-evals");
    expect(
      within(evals).getByText(
        "Add a direct cloud provider below. Then choose a judge model from it for each suite.",
      ),
    ).toBeInTheDocument();
    expect(
      within(evals).getByText("Blocked by the eval target model and grading"),
    ).toBeInTheDocument();
  });

  it("is read-only for someone who is not an owner or admin", () => {
    hookState.config = makeConfig({
      requireOrgKeys: true,
      canManage: false,
      eligibleConnectionIds: [],
      features: NO_PROVIDER_FEATURES,
    });
    render(
      <OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin={false} />,
    );

    expect(screen.getByTestId("org-ai-keys-toggle")).toBeDisabled();
    expect(
      screen.getByText("Only organization owners and admins can change this."),
    ).toBeInTheDocument();
    // Members are pointed at an admin, not at settings they cannot change.
    expect(
      within(screen.getByTestId("org-ai-feature-chat")).getByText(
        "Ask an organization admin to add a direct cloud provider.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("org-ai-keys-no-eligible-provider"),
    ).toHaveTextContent("Ask an organization admin to add one.");
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
    expect(
      screen.queryByTestId("org-ai-keys-enterprise-only"),
    ).not.toBeInTheDocument();
  });

  it("says the setting isn't available on a backend that cannot report all of it", () => {
    hookState = { ...hookState, config: undefined, unsupported: true };
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-ai-keys-unsupported")).toHaveTextContent(
      "This setting isn't available yet.",
    );
    expect(screen.queryByTestId("org-ai-keys-toggle")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-keys-toggle-loading"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("org-ai-keys-off-summary"),
    ).not.toBeInTheDocument();
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
      error:
        "Use your keys for all AI features is available on Enterprise plans.",
    };
    render(<OrganizationOrgKeysPolicyCard organizationId="org-1" isAdmin />);

    expect(screen.getByTestId("org-ai-keys-error")).toHaveTextContent(
      "Use your keys for all AI features is available on Enterprise plans.",
    );
  });
});

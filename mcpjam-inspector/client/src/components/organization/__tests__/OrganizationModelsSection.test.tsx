import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationModelsSection } from "../OrganizationModelsSection";

const mocks = vi.hoisted(() => ({
  pathname: "/organizations/org_1/models/usage",
  navigate: vi.fn(),
  useQuery: vi.fn(),
  upsertProvider: vi.fn(async (_args: unknown) => ({ success: true })),
  useAction: vi.fn(() => vi.fn(async () => ({ success: true }))),
}));

vi.mock("@/lib/app-navigation", () => ({
  useCurrentPathname: () => mocks.pathname,
  useAppNavigate: () => mocks.navigate,
}));

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useAction: mocks.useAction,
}));

// The AI keys card reads its own hook; `convex/react` above serves only the
// provider and usage queries. `aiConfig` is what the hook returns — or
// throws, the way `useQuery` does on a backend that lacks the function.
const aiConfigState = vi.hoisted(() => ({
  value: undefined as unknown,
  throws: null as Error | null,
}));

vi.mock("@/hooks/useOrgAiConfig", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useOrgAiConfig")>();
  return {
    ...actual,
    useOrgAiConfig: () => {
      if (aiConfigState.throws) throw aiConfigState.throws;
      return {
        config: aiConfigState.value,
        isLoading: aiConfigState.value === undefined,
        unsupported: false,
        error: null,
        isSaving: false,
        testError: null,
        isTesting: false,
        setRequireOrgKeys: vi.fn(),
        setAiModel: vi.fn(),
        testAiModel: vi.fn(),
      };
    },
  };
});

// The default model card, made to throw on demand: a render bug in it must
// never hide the AI keys switch.
const defaultModelCardState = vi.hoisted(() => ({
  throws: null as Error | null,
}));

vi.mock("../OrganizationDefaultModelCard", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../OrganizationDefaultModelCard")>();
  return {
    ...actual,
    OrganizationDefaultModelCard: (
      props: Parameters<typeof actual.OrganizationDefaultModelCard>[0],
    ) => {
      if (defaultModelCardState.throws) throw defaultModelCardState.throws;
      return <actual.OrganizationDefaultModelCard {...props} />;
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("OrganizationModelsSection", () => {
  beforeEach(() => {
    mocks.pathname = "/organizations/org_1/models/usage";
    mocks.navigate.mockClear();
    mocks.useQuery.mockReset();
    mocks.useAction.mockClear();
    aiConfigState.throws = null;
    defaultModelCardState.throws = null;
    aiConfigState.value = {
      organizationId: "org_1",
      aiKeyPolicy: { requireOrgKeys: false, revision: 0 },
      readiness: {
        requireOrgKeys: false,
        features: [],
        operations: [],
        eligibleConnectionIds: [],
      },
      canEnable: true,
      canManage: true,
    };
    mocks.useQuery.mockImplementation((name: string, args: unknown) => {
      if (name === "organizationModelProviders:getVisibleConfig") {
        return { providers: [] };
      }
      if (
        name === "organizationModelProviders:getUsageSummary" &&
        args !== "skip"
      ) {
        return {
          startAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          endAt: Date.now(),
          rangeDays: 30,
          total: {
            key: "total",
            requestCount: 2,
            inputTokens: 30,
            outputTokens: 12,
            totalTokens: 42,
            knownCostUsd: 0.1234,
            knownCostRequests: 1,
            unknownCostRequests: 1,
          },
          byDate: [],
          byProvider: [
            {
              key: "openai",
              requestCount: 2,
              inputTokens: 30,
              outputTokens: 12,
              totalTokens: 42,
              knownCostUsd: 0.1234,
              knownCostRequests: 1,
              unknownCostRequests: 1,
            },
          ],
          byModel: [
            {
              key: "gpt-4o-mini",
              requestCount: 2,
              inputTokens: 30,
              outputTokens: 12,
              totalTokens: 42,
              knownCostUsd: 0.1234,
              knownCostRequests: 1,
              unknownCostRequests: 1,
            },
          ],
          byProject: [],
          byUser: [],
          recentRecords: [],
        };
      }
      return undefined;
    });
  });

  it("links to usage beside provider actions without loading usage inline", () => {
    mocks.pathname = "/organizations/org_1/models";
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
    expect(
      screen.getByRole("button", { name: "Add Custom Provider" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See usage" }));
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/organizations/org_1/models/usage",
    );
    expect(mocks.useQuery).not.toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      expect.anything(),
    );
    expect(
      screen.queryByRole("heading", { name: "Usage" }),
    ).not.toBeInTheDocument();
  });

  it("shows org BYOK usage to admins", () => {
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getAllByText("42").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$0.1234")).toBeTruthy();
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThanOrEqual(1);
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      expect.objectContaining({
        organizationId: "org_1",
        rangeDays: 30,
      }),
    );
  });

  it("falls back to the per-model rows when the backend has no effort split", () => {
    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

    const table = screen.getByRole("table");
    const row = within(table).getByRole("row", { name: /gpt-4o-mini/ });
    expect(within(row).getByText("gpt-4o-mini")).toBeInTheDocument();
    // No reasoning split from an older backend: no tile, a dash in the table.
    expect(screen.queryByText("Reasoning", { selector: "div" })).toBeNull();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("breaks usage down by model and effort with reasoning tokens", () => {
    const base = mocks.useQuery.getMockImplementation()!;
    const aggregate = (overrides: Record<string, unknown>) => ({
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 0,
      knownCostUsd: 0,
      knownCostRequests: 0,
      unknownCostRequests: 1,
      ...overrides,
    });
    mocks.useQuery.mockImplementation((name: string, args: unknown) => {
      const result = base(name, args);
      if (name !== "organizationModelProviders:getUsageSummary" || !result) {
        return result;
      }
      return {
        ...result,
        total: { ...result.total, reasoningTokens: 1337 },
        byModelEffort: [
          aggregate({
            key: "claude-sonnet-4-5\u0000high",
            modelId: "claude-sonnet-4-5",
            reasoningEffort: "high",
            requestCount: 3,
            totalTokens: 9000,
            reasoningTokens: 1300,
            knownCostUsd: 0.5,
            knownCostRequests: 3,
            unknownCostRequests: 0,
          }),
          aggregate({
            key: "claude-sonnet-4-5\u0000default",
            modelId: "claude-sonnet-4-5",
            reasoningEffort: "default",
            reasoningTokens: 37,
          }),
        ],
      };
    });

    render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

    const reasoningTile = screen.getByText("Reasoning", {
      selector: "div",
    }).parentElement!;
    expect(within(reasoningTile).getByText("1,337")).toBeInTheDocument();

    const table = screen.getByRole("table");
    const high = within(table).getByRole("row", {
      name: /claude-sonnet-4-5 · High/,
    });
    expect(within(high).getByText("9,000")).toBeInTheDocument();
    expect(within(high).getByText("1,300")).toBeInTheDocument();
    expect(within(high).getByText("$0.50")).toBeInTheDocument();
    const fallback = within(table).getByRole("row", {
      name: /claude-sonnet-4-5 · Default/,
    });
    expect(within(fallback).getByText("37")).toBeInTheDocument();
    // No cost reported for that row: a dash, never "$0".
    expect(within(fallback).getByText("—")).toBeInTheDocument();
    // The effort split replaces the bare per-model rows.
    expect(within(table).queryByText("gpt-4o-mini")).toBeNull();
  });

  it("keeps usage hidden from non-admin members", () => {
    render(
      <OrganizationModelsSection organizationId="org_1" isAdmin={false} />,
    );

    expect(screen.queryByText("Usage")).toBeNull();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "organizationModelProviders:getUsageSummary",
      "skip",
    );
  });

  describe("AI keys", () => {
    beforeEach(() => {
      mocks.pathname = "/organizations/org_1/models";
    });

    it("mounts the AI keys card between the header and the provider list", () => {
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      const header = screen.getByRole("heading", { name: "AI providers" });
      const policy = screen.getByTestId("org-ai-keys-card");
      const providers = screen.getByRole("heading", { name: "Providers" });
      const firstProvider = screen.getByText("OpenAI");

      const follows = (a: Element, b: Element) =>
        Boolean(
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      expect(follows(header, policy)).toBe(true);
      expect(follows(policy, providers)).toBe(true);
      expect(follows(providers, firstProvider)).toBe(true);
      expect(
        screen.getByRole("switch", {
          name: "Use your keys for all AI features",
        }),
      ).not.toBeChecked();
    });

    it("has no model roles card", () => {
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      expect(
        screen.queryByRole("button", { name: "Advanced" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Default model roles/)).not.toBeInTheDocument();
    });

    it("mounts the default model card under the AI keys card", () => {
      aiConfigState.value = {
        ...(aiConfigState.value as object),
        supportedModelKinds: ["default"],
        aiModels: { default: null },
      };
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      const policy = screen.getByTestId("org-ai-keys-card");
      const defaultModel = screen.getByTestId("org-ai-default-model-card");
      const providers = screen.getByRole("heading", { name: "Providers" });
      const follows = (a: Element, b: Element) =>
        Boolean(
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      expect(follows(policy, defaultModel)).toBe(true);
      expect(follows(defaultModel, providers)).toBe(true);
      expect(
        within(defaultModel).getByTestId("org-ai-model-default"),
      ).toBeInTheDocument();
    });

    it("shows no default model card on a backend without organization AI models", () => {
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      expect(screen.getByTestId("org-ai-keys-card")).toBeInTheDocument();
      expect(
        screen.queryByTestId("org-ai-default-model-card"),
      ).not.toBeInTheDocument();
    });

    it("keeps the AI keys switch when the default model card throws", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      aiConfigState.value = {
        ...(aiConfigState.value as object),
        supportedModelKinds: ["default"],
        aiModels: { default: null },
      };
      defaultModelCardState.throws = new TypeError(
        "Cannot read properties of undefined (reading 'selection')",
      );
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      expect(screen.getByTestId("org-ai-keys-card")).toBeInTheDocument();
      expect(
        screen.getByRole("switch", {
          name: "Use your keys for all AI features",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("org-ai-default-model-error"),
      ).toHaveTextContent("Couldn't show the default AI model");
      expect(
        screen.queryByTestId("org-ai-default-model-card"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("org-ai-config-error")).toBeNull();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
    });

    it("shows an error in place of the AI keys setting when the query fails", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      aiConfigState.throws = new Error(
        "[CONVEX Q(aiExecutionAdmission:getOrganizationAiConfig)] [Request ID: 5eb87f6c9d3ef8d5] Server Error\n  Called by client",
      );
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      expect(screen.getAllByTestId("org-ai-config-error")).toHaveLength(1);
      expect(screen.queryByTestId("org-ai-keys-card")).not.toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
    });

    it("renders the providers without the AI keys setting on an older backend", () => {
      aiConfigState.throws = new Error(
        "[CONVEX Q(aiExecutionAdmission:getOrganizationAiConfig)] [Request ID: abc] Could not find public function for 'aiExecutionAdmission:getOrganizationAiConfig'",
      );
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);

      expect(screen.queryByTestId("org-ai-keys-card")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", {
          name: "Use your keys for all AI features",
        }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Add Custom Provider" }),
      ).toBeInTheDocument();
    });
  });

  describe("provider configuration", () => {
    beforeEach(() => {
      mocks.pathname = "/organizations/org_1/models";
      mocks.upsertProvider.mockClear();
      mocks.useAction.mockImplementation(((name: string) =>
        name === "organizationModelProviders:upsertProvider"
          ? mocks.upsertProvider
          : vi.fn(async () => ({ success: true }))) as never);
    });

    function configure(providerName: string) {
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
      const row = screen.getByText(providerName).closest("div.rounded-md");
      expect(row).not.toBeNull();
      fireEvent.click(
        within(row as HTMLElement).getByRole("button", { name: "Configure" }),
      );
    }

    const field = (id: string) => document.getElementById(id) as HTMLElement;
    const type = (id: string, value: string) =>
      fireEvent.change(field(id), { target: { value } });
    const saveButton = () => screen.getByRole("button", { name: "Save" });

    it("lists the OpenAI-compatible providers the backend accepts", () => {
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
      for (const name of ["Moonshot AI", "Z.ai", "Qwen", "MiniMax"]) {
        expect(screen.getByText(name)).toBeInTheDocument();
      }
    });

    it("saves Azure deployment names as the provider's modelIds", async () => {
      configure("Azure OpenAI");
      type("org-provider-secret", "placeholder-key");
      type("org-provider-url", "https://contoso.openai.azure.com/openai");
      expect(screen.getByText("Deployment Names")).toBeInTheDocument();
      // A deployment is required: the static azure rows name none.
      expect(saveButton()).toBeDisabled();
      type("org-provider-model-ids", "prod-gpt51, , eval.mini");
      fireEvent.click(saveButton());
      await vi.waitFor(() =>
        expect(mocks.upsertProvider).toHaveBeenCalledWith({
          organizationId: "org_1",
          providerKey: "azure",
          secret: "placeholder-key",
          baseUrl: "https://contoso.openai.azure.com/openai",
          modelIds: ["prod-gpt51", "eval.mini"],
        }),
      );
    });

    it("saves Ollama model names", async () => {
      configure("Ollama");
      type("org-provider-url", "http://127.0.0.1:11434/api");
      expect(saveButton()).toBeDisabled();
      type("org-provider-model-ids", "llama3.2:latest, qwen3:8b");
      fireEvent.click(saveButton());
      await vi.waitFor(() =>
        expect(mocks.upsertProvider).toHaveBeenCalledWith({
          organizationId: "org_1",
          providerKey: "ollama",
          baseUrl: "http://127.0.0.1:11434/api",
          modelIds: ["llama3.2:latest", "qwen3:8b"],
        }),
      );
    });

    it("saves a key and model ids for Moonshot AI", async () => {
      configure("Moonshot AI");
      type("org-provider-secret", "placeholder-key");
      expect(saveButton()).toBeDisabled();
      type("org-provider-model-ids", "kimi-k2-0905-preview");
      fireEvent.click(saveButton());
      await vi.waitFor(() =>
        expect(mocks.upsertProvider).toHaveBeenCalledWith({
          organizationId: "org_1",
          providerKey: "moonshotai",
          secret: "placeholder-key",
          modelIds: ["kimi-k2-0905-preview"],
        }),
      );
    });

    it("keeps an existing Azure config's deployments on edit", () => {
      mocks.useQuery.mockImplementation((name: string) =>
        name === "organizationModelProviders:getVisibleConfig"
          ? {
              providers: [
                {
                  providerKey: "azure",
                  enabled: true,
                  hasSecret: true,
                  baseUrl: "https://contoso.openai.azure.com/openai",
                  modelIds: ["prod-gpt51"],
                },
              ],
            }
          : undefined,
      );
      render(<OrganizationModelsSection organizationId="org_1" isAdmin />);
      const row = screen.getByText("Azure OpenAI").closest("div.rounded-md");
      const buttons = within(row as HTMLElement).getAllByRole("button");
      fireEvent.click(buttons[0]);
      expect((field("org-provider-model-ids") as HTMLInputElement).value).toBe(
        "prod-gpt51",
      );
      expect(saveButton()).not.toBeDisabled();
    });
  });
});

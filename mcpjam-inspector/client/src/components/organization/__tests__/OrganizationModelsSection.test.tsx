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
    expect(screen.getByText("42")).toBeTruthy();
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelDefinition } from "@/shared/types";
import { RecommendedHosts } from "../RecommendedHosts";

const createHost = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const models = vi.hoisted(() => ({
  state: {
    availableModels: [] as ModelDefinition[],
    requireOrgKeys: false,
    modelSelectionsSupported: true,
    pending: false,
    onManageOrgProviders: undefined as (() => void) | undefined,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  buildHostsPath: (id: string) => `/hosts/${id}`,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({ createHost }),
}));
vi.mock("@/hooks/useProjects", () => ({
  PROJECT_CLIENTS_ADMIN_ONLY_MESSAGE: "Admins only.",
  useCanManageProjectClients: () => ({ canManage: true, isLoading: false }),
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: (s: { themeMode: string }) => unknown) =>
    select({ themeMode: "light" }),
}));
vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const sdk = await vi.importActual<typeof import("@mcpjam/sdk/host-compat")>(
    "@mcpjam/sdk/host-compat",
  );
  return {
    useHostCatalog: () => ({
      status: "live",
      catalog: sdk.bundledHostCompatCatalog(),
      version: 1,
      source: "live",
    }),
  };
});
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => models.state,
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

const ORG_LUNA = {
  id: "gpt-6-luna",
  name: "GPT-6 Luna",
  provider: "openai",
  hosted: false,
  orgProvider: { providerKey: "openai", id: "orgprov_openai" },
} as ModelDefinition;
const ORG_SONNET = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  hosted: false,
  orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
} as ModelDefinition;

function chatgptButton() {
  return screen.getByRole("button", { name: /ChatGPT/ });
}

async function createChatgpt() {
  render(<RecommendedHosts projectId="project-1" />);
  await userEvent.click(chatgptButton());
}

beforeEach(() => {
  vi.clearAllMocks();
  createHost.mockResolvedValue({ hostId: "host-1" });
  models.state = {
    availableModels: [],
    requireOrgKeys: false,
    modelSelectionsSupported: true,
    pending: false,
    onManageOrgProviders: undefined,
  };
});

describe("Home → ChatGPT → Create (QA-25)", () => {
  it("policy off: saves the template's model, as before", async () => {
    await createChatgpt();
    await waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    const { input } = createHost.mock.calls[0][0];
    expect(input.modelId).toBe("openai/gpt-6-luna");
    expect(input.modelSelection).toBeUndefined();
    expect(toastSuccess).toHaveBeenCalledWith("Created ChatGPT client.");
  });

  it("policy on: saves the template's model on the organization connection", async () => {
    models.state = {
      ...models.state,
      requireOrgKeys: true,
      availableModels: [ORG_SONNET, ORG_LUNA],
    };
    await createChatgpt();
    await waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    const { input } = createHost.mock.calls[0][0];
    expect(input.modelId).toBe("openai/gpt-6-luna");
    expect(input.modelSelection).toMatchObject({
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_openai" },
    });
    expect(toastSuccess).toHaveBeenCalledWith("Created ChatGPT client.");
  });

  it("policy on: preserves the unavailable template model and prompts for a choice", async () => {
    models.state = {
      ...models.state,
      requireOrgKeys: true,
      availableModels: [ORG_SONNET],
    };
    await createChatgpt();
    await waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    expect(createHost.mock.calls[0][0].input.modelId).toBe(
      "openai/gpt-6-luna",
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      "Created ChatGPT client. Choose an organization model in the client's Agent tab before running it.",
    );
  });

  it("policy on with no organization model: creates nothing and says why", async () => {
    const openProviders = vi.fn();
    models.state = {
      ...models.state,
      requireOrgKeys: true,
      onManageOrgProviders: openProviders,
    };
    await createChatgpt();
    expect(createHost).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("ChatGPT was not created."),
      { action: { label: "Open AI providers", onClick: openProviders } },
    );
  });

  it("waits for the policy before Create can be clicked", () => {
    models.state = { ...models.state, pending: true };
    render(<RecommendedHosts projectId="project-1" />);
    expect(chatgptButton()).toBeDisabled();
  });
});

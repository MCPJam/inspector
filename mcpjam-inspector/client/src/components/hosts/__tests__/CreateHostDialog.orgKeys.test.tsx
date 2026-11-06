import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelDefinition } from "@/shared/types";
import { CreateHostDialog } from "../CreateHostDialog";

const createHost = vi.fn();
const createProjectSecret = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const models = vi.hoisted(() => ({
  state: {
    availableModels: [] as ModelDefinition[],
    requireOrgKeys: true,
    modelSelectionsSupported: true,
    pending: false,
    onManageOrgProviders: undefined as (() => void) | undefined,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useLocalHarnessEnabled: () => false,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({ useIsMemberActor: () => true }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/useClients", () => ({
  useHostMutations: () => ({ createHost }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => [],
  useCreateProjectSecret: () => createProjectSecret,
  useUpdateProjectSecret: () => vi.fn(),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/hooks/useProjects", () => ({
  PROJECT_CLIENTS_ADMIN_ONLY_MESSAGE: "Admins only.",
  useCanManageProjectClients: () => ({ canManage: true, isLoading: false }),
}));
vi.mock("@/hooks/useClaudeCodeHostEnabled", () => ({
  useClaudeCodeHostEnabled: () => false,
}));
vi.mock("@/hooks/useCodexHostEnabled", () => ({
  LOCAL_CODEX_FEATURE_FLAG: "local-codex",
  useCodexHostEnabled: () => false,
}));
vi.mock("@/hooks/useCursorHostEnabled", () => ({
  useCursorHostEnabled: () => false,
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
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    loading: vi.fn(),
  },
}));

const ORG_SONNET = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  hosted: false,
  orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
} as ModelDefinition;

function renderDialog() {
  render(
    <CreateHostDialog
      isOpen
      onClose={vi.fn()}
      projectId="project-1"
      onCreated={vi.fn()}
    />,
  );
  return screen.getByRole("button", { name: "Create" });
}

beforeEach(() => {
  vi.clearAllMocks();
  createHost.mockResolvedValue({ hostId: "host-1", hostConfigId: "cfg-1" });
  models.state = {
    availableModels: [],
    requireOrgKeys: true,
    modelSelectionsSupported: true,
    pending: false,
    onManageOrgProviders: undefined,
  };
});

describe("Create client dialog under the organization key policy (QA-25)", () => {
  it("keeps an unavailable template model and prompts for an explicit choice", async () => {
    models.state = { ...models.state, availableModels: [ORG_SONNET] };
    const create = renderDialog();
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    await waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    const { input } = createHost.mock.calls[0][0];
    expect(input.modelId).toBe("anthropic/claude-haiku-5.5");
    expect(input.modelSelection).toBeUndefined();
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("Choose an organization model in the client's Agent tab"),
    );
  });

  it("with no organization model, writes nothing and says why", async () => {
    const create = renderDialog();
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(createHost).not.toHaveBeenCalled();
    expect(createProjectSecret).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("was not created"),
      undefined,
    );
  });

  it("keeps Create disabled while the policy is loading", () => {
    models.state = { ...models.state, pending: true, availableModels: [ORG_SONNET] };
    expect(renderDialog()).toBeDisabled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateHostDialog } from "../CreateHostDialog";

const createHost = vi.fn();
const createProjectSecret = vi.fn();
const updateProjectSecret = vi.fn();

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
// The project's secrets never answer: a Cursor client must not wait on them.
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => undefined,
  useCreateProjectSecret: () => createProjectSecret,
  useUpdateProjectSecret: () => updateProjectSecret,
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
  useCursorHostEnabled: () => true,
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
  useAvailableModels: () => ({
    availableModels: [],
    requireOrgKeys: false,
    modelSelectionsSupported: true,
    pending: false,
    onManageOrgProviders: undefined,
  }),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  createHost.mockResolvedValue({ hostId: "host-1", hostConfigId: "cfg-1" });
});

describe("creating a Cursor CLI client", () => {
  it("never asks for a key: the client runs on the organization's", async () => {
    render(
      <CreateHostDialog
        isOpen
        onClose={vi.fn()}
        projectId="project-1"
        onCreated={vi.fn()}
        initialTemplateId="cursor-cli"
      />,
    );
    const create = screen.getByRole("button", { name: "Create" });
    expect(screen.getByRole("button", { name: /Cursor CLI/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(create).toBeEnabled());
    expect(screen.queryByText(/API key/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/key/i)).toBeNull();

    await userEvent.click(create);
    await waitFor(() => expect(createHost).toHaveBeenCalledTimes(1));
    expect(createHost.mock.calls[0][0].input).toMatchObject({
      harness: "cursor",
    });
    expect(createProjectSecret).not.toHaveBeenCalled();
    expect(updateProjectSecret).not.toHaveBeenCalled();
  });
});

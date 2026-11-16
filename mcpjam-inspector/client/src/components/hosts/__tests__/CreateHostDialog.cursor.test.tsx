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
  useLocalHarnessRollouts: () => ({ "claude-code": false, codex: false, "copilot-cli": false }),
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
  const catalogState = {
    status: "live",
    catalog: sdk.bundledHostCompatCatalog(),
    version: 1,
    source: "live",
  };
  return {
    useHostCatalog: () => catalogState,
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

describe("CreateHostDialog", () => {
  it("constrains the dialog and scrolls only the responsive template grid", () => {
    render(
      <CreateHostDialog
        isOpen
        onClose={vi.fn()}
        projectId="project-1"
        onCreated={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const templates = screen.getByRole("group", {
      name: "Start from template",
    });
    expect(dialog).toHaveClass(
      "flex",
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto",
    );
    expect(templates).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
      "overscroll-contain",
      "grid-cols-2",
      "sm:grid-cols-3",
    );
    expect(templates).not.toContainElement(screen.getByLabelText("Name"));
    expect(templates).not.toContainElement(
      screen.getByRole("button", { name: "Create" }),
    );
    expect(templates).not.toContainElement(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(screen.getByRole("button", { name: "VS Code" })).toBeEnabled();
  });

  it("keeps a custom name when switching templates and can cancel", async () => {
    const onClose = vi.fn();
    render(
      <CreateHostDialog
        isOpen
        onClose={onClose}
        projectId="project-1"
        onCreated={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("VS Code"),
    );
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "My test client");
    await userEvent.click(screen.getByRole("button", { name: "Cursor CLI" }));
    expect(screen.getByRole("button", { name: "Cursor CLI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("My test client");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createHost).not.toHaveBeenCalled();
  });

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

  it("keeps a creation error outside the template scroller and allows retry", async () => {
    createHost.mockRejectedValueOnce(new Error("Unable to create client"));
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
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to create client",
    );
    expect(
      screen.getByRole("group", { name: "Start from template" }),
    ).not.toContainElement(screen.getByRole("alert"));
    expect(create).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

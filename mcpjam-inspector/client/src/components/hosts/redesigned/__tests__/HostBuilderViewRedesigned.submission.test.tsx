import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  submitServerDraft,
  type ServerConnectionSubmit,
} from "@/lib/server-connection-submission";
import { HostBuilderViewRedesigned } from "../HostBuilderViewRedesigned";

const { createServer, toastError, toastSuccess } = vi.hoisted(() => ({
  createServer: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
const host = {
  name: "Test client",
  config: { ...emptyHostConfigInputV2(), id: "snapshot" },
};

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useLocation: () => ({ search: "" }),
}));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHost: () => ({ host }),
  useHostMutations: () => ({ updateHost: vi.fn() }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({ servers: [] }),
  useServerMutations: () => ({ createServer }),
}));
vi.mock("@/hooks/useAutoConnectProjectServers", () => ({
  useAutoConnectProjectServers: vi.fn(),
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
  useBrowserEnabled: () => false,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({ useSkillsEnabled: () => false }));
vi.mock("@/hooks/useProjectComputer", () => ({
  useComputerStatus: () => undefined,
}));
vi.mock("@/hooks/useBuiltInToolCatalog", () => ({
  useBuiltInToolCatalog: () => [],
}));
vi.mock("@/hooks/useBrowserProfileName", () => ({
  useBrowserProfileName: () => "Default",
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));
vi.mock("../canvas/canvasBuilder", () => ({
  buildRedesignedHostCanvas: () => ({}),
}));
vi.mock("../canvas/RedesignedHostCanvas", () => ({
  RedesignedHostCanvas: ({ onAddServer }: { onAddServer: () => void }) => (
    <button onClick={onAddServer}>Add server</button>
  ),
}));
vi.mock("../HostCanvasSelector", () => ({ HostCanvasSelector: () => null }));
vi.mock("../focus/HostFocusPanel", () => ({ HostFocusPanel: () => null }));
vi.mock("@/components/hosts/HostSectionTabs", () => ({
  HostSectionTabs: () => null,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));
vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: ({
    onSubmit,
    onClose,
  }: {
    onSubmit: ServerConnectionSubmit;
    onClose: () => void;
  }) => (
    <button
      onClick={() => {
        void submitServerDraft(onSubmit, {
          name: "draft-server",
          type: "http",
          url: "https://example.com/mcp",
        }).then((accepted) => {
          if (accepted) onClose();
        });
      }}
    >
      Submit server draft
    </button>
  ),
}));

function openDraft() {
  render(
    <TooltipProvider>
      <HostBuilderViewRedesigned hostId="host-1" projectId="project-1" />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit server draft" }));
}

describe("Host Builder server submission owner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acknowledges creation and closes the draft after the backend accepts", async () => {
    createServer.mockResolvedValue("server-1");
    openDraft();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Submit server draft" }),
      ).not.toBeInTheDocument(),
    );
    expect(createServer).toHaveBeenCalledOnce();
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "draft-server", projectId: "project-1" }),
    );
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("keeps the draft open and suppresses duplicate toasts when creation is rejected", async () => {
    createServer.mockRejectedValue(new Error("creation rejected"));
    openDraft();
    await waitFor(() => expect(createServer).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Submit server draft" }),
    ).toBeVisible();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

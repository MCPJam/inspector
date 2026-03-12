import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SandboxesTab } from "../SandboxesTab";
import { buildSandboxLink } from "@/lib/sandbox-session";

const mockDeleteSandbox = vi.fn();
const mockDuplicateSandbox = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
};

Object.assign(navigator, { clipboard: mockClipboard });

const sandboxList = [
  {
    sandboxId: "sbx-1",
    workspaceId: "ws-1",
    name: "Alpha",
    description: "Alpha description",
    hostStyle: "claude" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["alpha-server"],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    sandboxId: "sbx-2",
    workspaceId: "ws-1",
    name: "Beta",
    description: "Beta description",
    hostStyle: "chatgpt" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["beta-server"],
    createdAt: 2,
    updatedAt: 2,
  },
];

const sandboxDetails: Record<string, any> = {
  "sbx-1": {
    ...sandboxList[0],
    systemPrompt: "You are Alpha.",
    modelId: "gpt-4o-mini",
    temperature: 0.4,
    requireToolApproval: true,
    servers: [
      {
        serverId: "server-1",
        serverName: "alpha-server",
        useOAuth: false,
        serverUrl: "https://example.com/alpha",
        clientId: null,
        oauthScopes: null,
      },
    ],
    link: {
      token: "alpha-token",
      path: "/sandbox/alpha/alpha-token",
      url: "https://app.mcpjam.com/sandbox/alpha/alpha-token",
      rotatedAt: 1,
      updatedAt: 1,
    },
    members: [],
  },
  "sbx-2": {
    ...sandboxList[1],
    systemPrompt: "You are Beta.",
    modelId: "gpt-4o-mini",
    temperature: 0.5,
    requireToolApproval: false,
    servers: [
      {
        serverId: "server-2",
        serverName: "beta-server",
        useOAuth: false,
        serverUrl: "https://example.com/beta",
        clientId: null,
        oauthScopes: null,
      },
    ],
    link: {
      token: "beta-token",
      path: "/sandbox/beta/beta-token",
      url: "https://app.mcpjam.com/sandbox/beta/beta-token",
      rotatedAt: 2,
      updatedAt: 2,
    },
    members: [],
  },
  "sbx-3": {
    ...sandboxList[1],
    sandboxId: "sbx-3",
    name: "Beta (Copy)",
    systemPrompt: "You are Beta.",
    modelId: "gpt-4o-mini",
    temperature: 0.5,
    requireToolApproval: false,
    servers: [
      {
        serverId: "server-2",
        serverName: "beta-server",
        useOAuth: false,
        serverUrl: "https://example.com/beta",
        clientId: null,
        oauthScopes: null,
      },
    ],
    link: {
      token: "beta-copy-token",
      path: "/sandbox/beta-copy/beta-copy-token",
      url: "https://app.mcpjam.com/sandbox/beta-copy/beta-copy-token",
      rotatedAt: 3,
      updatedAt: 3,
    },
    members: [],
  },
};

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/hooks/useViews", () => ({
  useWorkspaceServers: () => ({
    servers: [],
  }),
}));

vi.mock("@/hooks/useSandboxes", () => ({
  useSandboxList: () => ({
    sandboxes: sandboxList,
    isLoading: false,
  }),
  useSandbox: ({ sandboxId }: { sandboxId: string | null }) => ({
    sandbox: sandboxId ? (sandboxDetails[sandboxId] ?? null) : null,
    isLoading: false,
  }),
  useSandboxMutations: () => ({
    deleteSandbox: mockDeleteSandbox,
    duplicateSandbox: mockDuplicateSandbox,
  }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    className?: string;
  }) => (
    <button className={className} onClick={onClick} type="button">
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <div />,
}));

vi.mock("@/components/sandboxes/SandboxUsagePanel", () => ({
  SandboxUsagePanel: ({ sandbox }: { sandbox: { name: string } }) => (
    <div>{sandbox.name}</div>
  ),
}));

vi.mock("@/components/sandboxes/SandboxEditor", () => ({
  SandboxEditor: () => <div>Sandbox editor</div>,
}));

describe("SandboxesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDuplicateSandbox.mockResolvedValue(sandboxDetails["sbx-3"]);
    mockDeleteSandbox.mockResolvedValue({ deleted: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("duplicates the clicked sandbox instead of the currently selected one", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(screen.getAllByText("Duplicate")[1]!);

    await waitFor(() => {
      expect(mockDuplicateSandbox).toHaveBeenCalledWith({
        sandboxId: "sbx-2",
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Sandbox duplicated as "Beta (Copy)"',
    );
  });

  it("deletes the clicked sandbox instead of the currently selected one", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(screen.getAllByText("Delete")[1]!);

    await waitFor(() => {
      expect(mockDeleteSandbox).toHaveBeenCalledWith({
        sandboxId: "sbx-2",
      });
    });
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete "Beta"? This will also delete persisted usage history.',
    );
  });

  it("opens the selected sandbox from the icon action", () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Open sandbox" })[0]!,
    );

    expect(window.open).toHaveBeenCalledWith(
      buildSandboxLink("alpha-token", "Alpha"),
      "_blank",
    );
  });

  it("copies the selected sandbox link from the icon action", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Copy sandbox link" })[0]!,
    );

    await waitFor(() => {
      expect(mockClipboard.writeText).toHaveBeenCalledWith(
        buildSandboxLink("alpha-token", "Alpha"),
      );
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Sandbox link copied");
  });

  it("keeps the row action icons visible without hover-only classes", () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    for (const button of screen.getAllByRole("button", {
      name: "Copy sandbox link",
    })) {
      expect(button).not.toHaveClass("opacity-0");
    }

    for (const button of screen.getAllByRole("button", {
      name: "Open sandbox",
    })) {
      expect(button).not.toHaveClass("opacity-0");
    }

    for (const button of screen.getAllByRole("button", {
      name: "Sandbox actions",
    })) {
      expect(button).not.toHaveClass("opacity-0");
    }
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxEditor } from "../SandboxEditor";

const {
  mockCreateSandbox,
  mockUpdateSandbox,
  mockDeleteSandbox,
  mockSetSandboxMode,
  mockCreateServer,
  mockWritePlaygroundSession,
  mockBuildPlaygroundSandboxLink,
  mockPreviewMount,
  mockAuthorizeServer,
  mockMarkOAuthRequired,
} = vi.hoisted(() => ({
  mockCreateSandbox: vi.fn(),
  mockUpdateSandbox: vi.fn(),
  mockDeleteSandbox: vi.fn(),
  mockSetSandboxMode: vi.fn(),
  mockCreateServer: vi.fn(),
  mockWritePlaygroundSession: vi.fn(),
  mockBuildPlaygroundSandboxLink: vi.fn(
    (token: string, _name: string, playgroundId: string) =>
      `https://example.com/sandbox/${token}?playground=1&playgroundId=${playgroundId}`,
  ),
  mockPreviewMount: vi.fn(),
  mockAuthorizeServer: vi.fn(),
  mockMarkOAuthRequired: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/useSandboxes", () => ({
  useSandboxMutations: () => ({
    createSandbox: mockCreateSandbox,
    updateSandbox: mockUpdateSandbox,
    deleteSandbox: mockDeleteSandbox,
    setSandboxMode: mockSetSandboxMode,
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useServerMutations: () => ({
    createServer: mockCreateServer,
  }),
}));

vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: () => null,
}));

vi.mock("@/components/sandboxes/SandboxShareSection", () => ({
  SandboxShareSection: () => <div>Sandbox share</div>,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/hosted/use-hosted-oauth-gate", () => ({
  useHostedOAuthGate: () => ({
    oauthStateByServerId: {},
    pendingOAuthServers: [],
    authorizeServer: mockAuthorizeServer,
    markOAuthRequired: mockMarkOAuthRequired,
  }),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  getStoredTokens: vi.fn(() => null),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/sandbox-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sandbox-session")>(
    "@/lib/sandbox-session",
  );
  return {
    ...actual,
    writePlaygroundSession: mockWritePlaygroundSession,
    buildPlaygroundSandboxLink: mockBuildPlaygroundSandboxLink,
  };
});

vi.mock("@/components/ChatTabV2", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatTabV2: (props: {
      hostedSandboxSurface?: string;
      initialModelId?: string;
      initialSystemPrompt?: string;
      initialTemperature?: number;
      initialRequireToolApproval?: boolean;
    }) => {
      React.useEffect(() => {
        mockPreviewMount(props);
      }, []);

      return <div data-testid="sandbox-preview-chat">preview</div>;
    },
  };
});

const sandbox = {
  sandboxId: "sbx_1",
  workspaceId: "ws_1",
  name: "Demo Sandbox",
  description: "Initial description",
  hostStyle: "claude" as const,
  systemPrompt: "You are helpful.",
  modelId: "openai/gpt-5-mini",
  temperature: 0.4,
  requireToolApproval: true,
  allowGuestAccess: false,
  mode: "invited_only" as const,
  servers: [
    {
      serverId: "srv_1",
      serverName: "Alpha",
      useOAuth: false,
      serverUrl: "https://example.com/mcp",
      clientId: null,
      oauthScopes: null,
    },
  ],
  link: {
    token: "sandbox-token",
    path: "/sandbox/demo/sandbox-token",
    url: "https://example.com/sandbox/demo/sandbox-token",
    rotatedAt: 1,
    updatedAt: 1,
  },
  members: [],
};

const workspaceServers = [
  {
    _id: "srv_1",
    name: "Alpha",
    transportType: "http" as const,
    url: "https://example.com/mcp",
    useOAuth: false,
    clientId: undefined,
    oauthScopes: undefined,
  },
];

describe("SandboxEditor preview", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.spyOn(window, "open").mockImplementation(() => null);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps preview disabled until the sandbox has a saved link", () => {
    render(
      <SandboxEditor
        workspaceId="ws_1"
        workspaceServers={workspaceServers}
        onBack={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
  });

  it("writes playground sessions and opens preview with internal surface", async () => {
    render(
      <SandboxEditor
        sandbox={sandbox}
        workspaceId="ws_1"
        workspaceServers={workspaceServers}
        onBack={() => {}}
      />,
    );

    expect(mockWritePlaygroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "sandbox-token",
        surface: "internal",
        payload: expect.objectContaining({
          sandboxId: "sbx_1",
          modelId: "openai/gpt-5-mini",
          systemPrompt: "You are helpful.",
        }),
        playgroundId: expect.any(String),
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(
      await screen.findByTestId("sandbox-preview-chat"),
    ).toBeInTheDocument();
    expect(mockPreviewMount).toHaveBeenCalledWith(
      expect.objectContaining({
        hostedSandboxSurface: "internal",
        initialModelId: "openai/gpt-5-mini",
        initialSystemPrompt: "You are helpful.",
        initialTemperature: 0.4,
        initialRequireToolApproval: true,
      }),
    );
  });

  it("debounces preview restarts for behavior changes only", async () => {
    render(
      <SandboxEditor
        sandbox={sandbox}
        workspaceId="ws_1"
        workspaceServers={workspaceServers}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByTestId("sandbox-preview-chat"),
    ).toBeInTheDocument();
    expect(mockPreviewMount).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("Add a description…"), {
      target: { value: "Only copy changes" },
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });

    expect(mockPreviewMount).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Advanced config"));
    const systemPromptField = screen
      .getAllByRole("textbox")
      .find((element) => element.tagName === "TEXTAREA");
    if (!(systemPromptField instanceof HTMLTextAreaElement)) {
      throw new Error("expected system prompt textarea");
    }
    fireEvent.change(systemPromptField, {
      target: { value: "Use tools carefully." },
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
    });

    expect(mockPreviewMount).toHaveBeenCalledTimes(2);
  });
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN_OAUTH_OVERLAY_READY_EVENT } from "@/lib/first-run-oauth-return";

const motionState = vi.hoisted(() => ({ reduced: false }));
const confidentialCimdProbe = vi.hoisted(() => ({ enabled: false }));
const analyticsState = vi.hoisted(() => ({
  entered: vi.fn(),
  connectionFailed: vi.fn(),
  screenViewed: vi.fn(),
  setupLater: vi.fn(),
}));

vi.mock("framer-motion", () => ({
  useReducedMotion: () => motionState.reduced,
}));

vi.mock("@/hooks/use-confidential-cimd-capability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-confidential-cimd-capability")>();
  return {
    ...actual,
    useConfidentialCimdCapability: (
      args: Parameters<typeof actual.useConfidentialCimdCapability>[0],
    ) => {
      confidentialCimdProbe.enabled = args.enabled;
      return actual.useConfidentialCimdCapability(args);
    },
  };
});

vi.mock("@/lib/first-run-onboarding-analytics", () => ({
  trackFirstRunConnectionFailed: analyticsState.connectionFailed,
  trackFirstRunOnboardingEntered: analyticsState.entered,
  trackFirstRunOnboardingScreenViewed: analyticsState.screenViewed,
  trackFirstRunSetupLater: analyticsState.setupLater,
}));

import {
  FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS,
  FirstRunOnboardingOverlay,
  type FirstRunConnectionState,
  type FirstRunServerDraft,
} from "../FirstRunOnboardingOverlay";
import type { GuestSessionRefusalReason } from "@/lib/guest-session";

/** The sign-in action reads "Connect" once non-OAuth auth is chosen. */
const AUTHORIZE = /^(Continue to sign-in|Connect)$/;

function renderOverlay(
  connectionState: FirstRunConnectionState = { status: "idle" },
  recoveryServerDraft?: FirstRunServerDraft,
  guestSessionRefusal: GuestSessionRefusalReason | null = null,
) {
  const onConnectOwnServer = vi.fn();
  const onConnectDemo = vi.fn();
  const onAuthorizeConnection = vi.fn();
  const onCancelConnection = vi.fn();
  const onReturnToChoice = vi.fn();
  const onOpenPlayground = vi.fn();
  const onShown = vi.fn();
  const onSkip = vi.fn();
  const onSignIn = vi.fn();
  const view = render(
    <FirstRunOnboardingOverlay
      open
      connectionState={connectionState}
      recoveryServerDraft={recoveryServerDraft}
      onConnectOwnServer={onConnectOwnServer}
      onConnectDemo={onConnectDemo}
      onAuthorizeConnection={onAuthorizeConnection}
      onCancelConnection={onCancelConnection}
      onReturnToChoice={onReturnToChoice}
      onOpenPlayground={onOpenPlayground}
      onShown={onShown}
      onSkip={onSkip}
      guestSessionRefusal={guestSessionRefusal}
      onSignIn={onSignIn}
    />,
  );
  return {
    view,
    onConnectOwnServer,
    onConnectDemo,
    onAuthorizeConnection,
    onCancelConnection,
    onReturnToChoice,
    onOpenPlayground,
    onShown,
    onSkip,
    onSignIn,
    rerenderWithConnectionState: (
      nextConnectionState: FirstRunConnectionState,
    ) =>
      view.rerender(
        <FirstRunOnboardingOverlay
          open
          connectionState={nextConnectionState}
          recoveryServerDraft={recoveryServerDraft}
          onConnectOwnServer={onConnectOwnServer}
          onConnectDemo={onConnectDemo}
          onAuthorizeConnection={onAuthorizeConnection}
          onCancelConnection={onCancelConnection}
          onReturnToChoice={onReturnToChoice}
          onOpenPlayground={onOpenPlayground}
          onShown={onShown}
          onSkip={onSkip}
          guestSessionRefusal={guestSessionRefusal}
          onSignIn={onSignIn}
        />,
      ),
  };
}

afterEach(() => {
  cleanup();
  motionState.reduced = false;
  confidentialCimdProbe.enabled = false;
  analyticsState.entered.mockReset();
  analyticsState.connectionFailed.mockReset();
  analyticsState.screenViewed.mockReset();
  analyticsState.setupLater.mockReset();
  vi.useRealTimers();
});

describe("FirstRunOnboardingOverlay", () => {
  it("surfaces a refused guest session inside server choice", async () => {
    const { onConnectDemo, onConnectOwnServer, onSignIn } = renderOverlay(
      { status: "idle" },
      undefined,
      "rate_limited",
    );

    expect(screen.getByText("Guest session limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Try the Excalidraw sample server" }),
    ).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(onConnectDemo).not.toHaveBeenCalled();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
  });

  it("tells the visitor guest access is off when the deployment issues no guests", async () => {
    const { onSignIn } = renderOverlay(
      { status: "idle" },
      undefined,
      "guest_access_disabled",
    );

    expect(screen.getByText("Guest access is off")).toBeInTheDocument();
    expect(screen.queryByText("Guest session limit reached")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("records that onboarding was shown and opens on the connect step", () => {
    const { onShown } = renderOverlay();
    expect(onShown).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Connect an MCP server" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Welcome to MCPJam" }),
    ).not.toBeInTheDocument();
  });

  it("tracks entry once and each logical screen transition once", async () => {
    const { rerenderWithConnectionState } = renderOverlay();

    expect(analyticsState.entered).toHaveBeenCalledOnce();
    expect(analyticsState.entered).toHaveBeenCalledWith("server_choice");
    expect(analyticsState.screenViewed).toHaveBeenLastCalledWith(
      "server_choice",
    );

    rerenderWithConnectionState({
      status: "preparing",
      serverName: "Private value",
      serverKind: "personal",
    });
    expect(analyticsState.screenViewed).toHaveBeenLastCalledWith(
      "project_preparing",
    );

    rerenderWithConnectionState({
      status: "loading-tools",
      serverName: "Private value",
      serverKind: "personal",
    });
    expect(analyticsState.screenViewed).toHaveBeenLastCalledWith(
      "loading_tools",
    );

    rerenderWithConnectionState({
      status: "connected",
      serverName: "Private value",
      serverKind: "personal",
      toolCount: 2,
    });
    await waitFor(() =>
      expect(analyticsState.screenViewed).toHaveBeenLastCalledWith("connected"),
    );
    expect(analyticsState.entered).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(analyticsState.screenViewed.mock.calls),
    ).not.toContain("Private value");
  });

  it.each([
    [
      "connected",
      {
        status: "connected",
        serverName: "Restored",
        serverKind: "personal",
        toolCount: 2,
      },
    ],
    [
      "demo_failure",
      {
        status: "failed",
        serverName: "Restored",
        serverKind: "demo",
        error: "boom",
      },
    ],
  ] as const)(
    "records only the %s screen when resuming a restored connection",
    (expectedScreen, connectionState) => {
      renderOverlay(connectionState);

      expect(analyticsState.entered.mock.calls).toEqual([[expectedScreen]]);
      expect(analyticsState.screenViewed.mock.calls).toEqual([
        [expectedScreen],
      ]);
    },
  );

  it("tracks setup-later without form contents", () => {
    const { onSkip } = renderOverlay();
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://private.example/mcp" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(analyticsState.setupLater).toHaveBeenCalledOnce();
    expect(analyticsState.setupLater).toHaveBeenCalledWith();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("renders as a full page in the linen frame, not a floating modal", () => {
    renderOverlay();

    const page = screen.getByRole("dialog");
    expect(page).toHaveClass("fixed", "inset-0");
    expect(
      document.querySelector('[data-slot="dialog-overlay"]'),
    ).not.toBeInTheDocument();
    expect(page.querySelector(".bg-sidebar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://docs.mcpjam.com",
    );
    // The content column keeps a 1rem gutter on a phone.
    expect(page.querySelector(".max-w-xl")).toHaveClass("px-4");
  });

  it("keeps its current step if eligibility briefly flickers", () => {
    const {
      view,
      onConnectOwnServer,
      onConnectDemo,
      onCancelConnection,
      onReturnToChoice,
      onOpenPlayground,
      onShown,
      onSkip,
    } = renderOverlay();

    expect(
      screen.getByRole("heading", { name: "Connect an MCP server" }),
    ).toBeInTheDocument();

    const renderWithOpen = (open: boolean) => (
      <FirstRunOnboardingOverlay
        open={open}
        connectionState={{ status: "idle" }}
        onConnectOwnServer={onConnectOwnServer}
        onConnectDemo={onConnectDemo}
        onCancelConnection={onCancelConnection}
        onReturnToChoice={onReturnToChoice}
        onOpenPlayground={onOpenPlayground}
        onShown={onShown}
        onSkip={onSkip}
      />
    );

    view.rerender(renderWithOpen(false));
    view.rerender(renderWithOpen(true));

    expect(
      screen.getByRole("heading", { name: "Connect an MCP server" }),
    ).toBeInTheDocument();
  });

  it("delegates both connection paths and the explicit skip", () => {
    const {
      onConnectOwnServer,
      onConnectDemo,
      onReturnToChoice,
      onSkip,
      rerenderWithConnectionState,
    } = renderOverlay();

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith({
      name: "Example",
      transport: "http",
      urlOrCommand: "https://mcp.example.com/mcp",
      authentication: "auto",
    });

    rerenderWithConnectionState({
      status: "failed",
      serverName: "Example",
      serverKind: "personal",
      error: "Connection refused",
    });
    expect(
      screen.getByRole("heading", { name: "Couldn't connect to Example" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Details from the failed connection",
    );
    // The raw error is visible without a disclosure.
    expect(screen.getByText("Connection refused")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Enter a server URL or command.")).toBeVisible();
    expect(onConnectOwnServer).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "  https://mcp.example.com/mcp  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledTimes(2);
    expect(onConnectOwnServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Example",
        transport: "http",
        urlOrCommand: "https://mcp.example.com/mcp",
        authentication: "auto",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(onReturnToChoice).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Try the Excalidraw sample server",
      }),
    );
    expect(onConnectDemo).toHaveBeenCalledOnce();

    const skipButton = screen.getByRole("button", { name: "Skip for now" });
    expect(skipButton).toHaveClass("text-foreground", "underline");
    fireEvent.click(skipButton);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("shows project preparation separately from the MCP handshake", () => {
    const { rerenderWithConnectionState } = renderOverlay();

    rerenderWithConnectionState({
      status: "preparing",
      serverName: "Excalidraw (App)",
      serverKind: "demo",
    });

    expect(
      screen.getByRole("heading", {
        name: "Preparing your MCPJam workspace",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Getting your project ready to connect/i),
    ).toBeInTheDocument();
  });

  it("shows honest progress, supports cancel, and waits for an explicit Playground action", () => {
    vi.useFakeTimers();
    const {
      onCancelConnection,
      onOpenPlayground,
      rerenderWithConnectionState,
    } = renderOverlay();

    rerenderWithConnectionState({
      status: "connecting",
      serverName: "My server",
      serverKind: "personal",
    });

    expect(
      screen.getByRole("heading", { name: "Connecting to My server" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Reach the server")).toBeInTheDocument();
    expect(screen.getByText("Complete the MCP handshake")).toBeInTheDocument();
    expect(screen.getByText("Load tools")).toBeInTheDocument();
    expect(screen.getByText("Reach the server").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelConnection).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Connect an MCP server" }),
    ).toBeInTheDocument();

    rerenderWithConnectionState({
      status: "loading-tools",
      serverName: "My server",
      serverKind: "personal",
    });
    expect(screen.getByText("Load tools").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      screen.getByText("Reach the server").closest("li")?.querySelector("svg"),
    ).toHaveClass("text-success");

    rerenderWithConnectionState({
      status: "connected",
      serverName: "My server",
      serverKind: "personal",
      toolCount: 6,
      toolPreview: [
        { name: "search_orders", description: "Find orders by status" },
        { name: "get_order" },
      ],
    });
    act(() => {
      vi.advanceTimersByTime(FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS);
    });
    expect(
      screen.getByRole("heading", { name: "My server is connected" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("first-run-success-indicator")).toHaveClass(
      "bg-success",
      "animate-in",
    );
    expect(screen.getByText("6 tools ready to use")).toBeInTheDocument();
    expect(screen.getByText("search_orders")).toBeInTheDocument();
    expect(screen.getByText("Find orders by status")).toBeInTheDocument();
    expect(screen.getByText("get_order")).toBeInTheDocument();
    expect(screen.getByText("and 4 more")).toBeInTheDocument();

    rerenderWithConnectionState({
      status: "connected",
      serverName: "My server",
      serverKind: "personal",
      toolCount: null,
    });
    expect(
      screen.getByText("Tools can finish loading in the Playground."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tools" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Playground" }));
    expect(onOpenPlayground).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("asks for sign-in with the shared auth settings in view", () => {
    const {
      onAuthorizeConnection,
      onCancelConnection,
      rerenderWithConnectionState,
    } = renderOverlay();

    rerenderWithConnectionState({
      status: "authorization-required",
      serverName: "Multiaccount",
      serverKind: "personal",
    });

    expect(
      screen.getByRole("heading", { name: "Sign in to Multiaccount" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/MCPJam takes you to its sign-in page/),
    ).toBeInTheDocument();
    expect(screen.getByText("Sign in").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Advanced Settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to sign-in" }),
    );
    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "auto",
        oauthProtocolMode: "auto",
        registrationMode: "auto",
      }),
    );
    expect(onCancelConnection).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit server details" }),
    );
    expect(onCancelConnection).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Edit server details" }),
    ).toBeInTheDocument();
  });

  it("restores saved server details before editing a remounted OAuth recovery", () => {
    const { rerenderWithConnectionState } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Multiaccount",
        serverKind: "personal",
      },
      {
        name: "Multiaccount",
        transport: "http",
        urlOrCommand: "https://multiaccount.example/mcp",
        authentication: "auto",
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit server details" }),
    );
    rerenderWithConnectionState({ status: "idle" });

    expect(screen.getByLabelText("Name")).toHaveValue("Multiaccount");
    expect(screen.getByLabelText("Server URL or command")).toHaveValue(
      "https://multiaccount.example/mcp",
    );
  });

  it("keeps Bearer and its token field when editing server details", async () => {
    const { onConnectOwnServer, rerenderWithConnectionState } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Multiaccount",
        serverKind: "personal",
      },
      {
        name: "Multiaccount",
        transport: "http",
        urlOrCommand: "https://multiaccount.example/mcp",
        authentication: "auto",
      },
    );

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit server details" }),
    );
    rerenderWithConnectionState({ status: "idle" });

    expect(
      screen.getByRole("combobox", { name: "Authentication" }),
    ).toHaveTextContent("Bearer Token");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByText("Enter a bearer token to continue."),
    ).toBeInTheDocument();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        urlOrCommand: "https://multiaccount.example/mcp",
        authentication: "bearer",
        bearerToken: "secret-token",
      }),
    );
  });

  it("shows selected Bearer auth after a retry fails directly into server details", async () => {
    const { onConnectOwnServer, rerenderWithConnectionState } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Multiaccount",
        serverKind: "personal",
      },
      {
        name: "Multiaccount",
        transport: "http",
        urlOrCommand: "https://multiaccount.example/mcp",
        authentication: "auto",
      },
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));

    rerenderWithConnectionState({
      status: "failed",
      serverName: "Multiaccount",
      serverKind: "personal",
      error: "Connection refused",
    });
    expect(
      screen.getByRole("combobox", { name: "Authentication" }),
    ).toHaveTextContent("Bearer Token");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByText("Enter a bearer token to continue."),
    ).toBeInTheDocument();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "bearer",
        bearerToken: "secret-token",
      }),
    );
  });

  it("shows restored custom client credentials and separate OAuth scopes", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Multiaccount",
        serverKind: "personal",
      },
      {
        name: "Multiaccount",
        transport: "http",
        urlOrCommand: "https://multiaccount.example/mcp",
        authentication: "auto",
        registrationMode: "auto",
        clientId: "custom-client",
        oauthScopes: ["read", "write"],
      },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Advanced Settings" }),
    );
    expect(screen.getByPlaceholderText("Your OAuth Client ID")).toHaveValue(
      "custom-client",
    );
    expect(
      screen.getByPlaceholderText("Optional scopes separated by spaces"),
    ).toHaveValue("read write");
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));
    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "custom-client",
        oauthScopes: ["read", "write"],
      }),
    );
  });

  it.each(["authorization-required", "failed"] as const)(
    "preserves client-secret whitespace when submitting %s",
    async (status) => {
      const { onAuthorizeConnection, onConnectOwnServer } = renderOverlay(
        {
          status,
          serverName: "Secure",
          serverKind: "personal",
          ...(status === "failed" ? { error: "Connection refused" } : {}),
        },
        {
          name: "Secure",
          transport: "http",
          urlOrCommand: "https://secure.example/mcp",
          authentication: "oauth",
          registrationMode: "preregistered",
          clientId: "custom-client",
          clientSecret: "  opaque-secret  ",
        },
      );
      if (status === "failed") {
        fireEvent.change(screen.getByLabelText("Server URL or command"), {
          target: { value: "https://secure.example/mcp" },
        });
        await userEvent.click(
          screen.getByRole("combobox", { name: "Authentication" }),
        );
        await userEvent.click(screen.getByRole("option", { name: "OAuth" }));
        await userEvent.click(
          screen.getByRole("button", { name: "Advanced Settings" }),
        );
        const registrationSelect = screen
          .getByText("Registration Strategy")
          .parentElement?.querySelector('[role="combobox"]');
        await userEvent.click(registrationSelect!);
        await userEvent.click(
          screen.getByRole("option", { name: /Preregistration/ }),
        );
        fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
          target: { value: "custom-client" },
        });
        fireEvent.change(
          screen.getByPlaceholderText("Your OAuth Client Secret"),
          {
            target: { value: "  opaque-secret  " },
          },
        );
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: status === "failed" ? "Try again" : AUTHORIZE,
        }),
      );
      const submit =
        status === "failed" ? onConnectOwnServer : onAuthorizeConnection;
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ clientSecret: "  opaque-secret  " }),
      );
    },
  );

  it("clears hidden preregistered credentials when details switch to automatic registration", async () => {
    const { onConnectOwnServer } = renderOverlay({
      status: "failed",
      serverName: "Secure",
      serverKind: "personal",
      error: "Connection refused",
    });
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://secure.example/mcp" },
    });
    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "OAuth" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Advanced Settings" }),
    );
    const registrationSelect = screen
      .getByText("Registration Strategy")
      .parentElement?.querySelector('[role="combobox"]');
    expect(registrationSelect).not.toBeNull();
    await userEvent.click(registrationSelect!);
    await userEvent.click(
      screen.getByRole("option", { name: /Preregistration/ }),
    );
    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "old-client" },
    });
    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client Secret"), {
      target: { value: "old-secret" },
    });
    await userEvent.click(registrationSelect!);
    await userEvent.click(screen.getByRole("option", { name: "Automatic" }));
    expect(
      screen.queryByPlaceholderText("Your OAuth Client ID"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "oauth",
        registrationMode: "auto",
        clientId: "",
        clientSecret: undefined,
        clearClientSecret: true,
      }),
    );
  });

  it("shows a saved recovery secret and clears it when the client ID changes", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Secure",
        serverKind: "personal",
      },
      {
        name: "Secure",
        transport: "http",
        urlOrCommand: "https://secure.example/mcp",
        authentication: "oauth",
        registrationMode: "preregistered",
        clientId: "old-client",
        hasStoredClientSecret: true,
        projectId: "project_1",
        hostedServerId: "server_1",
      },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Advanced Settings" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reveal" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "new-client" },
    });
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));
    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "new-client",
        clientSecret: undefined,
        clearClientSecret: true,
      }),
    );
  });

  it("retains a saved client secret when retrying with the same client ID", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Secure",
        serverKind: "personal",
      },
      {
        name: "Secure",
        transport: "http",
        urlOrCommand: "https://secure.example/mcp",
        authentication: "oauth",
        registrationMode: "preregistered",
        clientId: "saved-client",
        hasStoredClientSecret: true,
      },
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: AUTHORIZE })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));
    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "saved-client",
        clientSecret: undefined,
        hasStoredClientSecret: true,
        clearClientSecret: false,
      }),
    );
  });

  it("keeps newly entered credentials after switching registration modes", async () => {
    const { onConnectOwnServer } = renderOverlay({
      status: "failed",
      serverName: "Secure",
      serverKind: "personal",
      error: "Connection refused",
    });
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://secure.example/mcp" },
    });
    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "OAuth" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Advanced Settings" }),
    );
    const registrationSelect = screen
      .getByText("Registration Strategy")
      .parentElement?.querySelector('[role="combobox"]');
    await userEvent.click(registrationSelect!);
    await userEvent.click(
      screen.getByRole("option", { name: /Preregistration/ }),
    );
    await userEvent.click(registrationSelect!);
    await userEvent.click(screen.getByRole("option", { name: "Automatic" }));
    await userEvent.click(registrationSelect!);
    await userEvent.click(
      screen.getByRole("option", { name: /Preregistration/ }),
    );
    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "new-client" },
    });
    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client Secret"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "new-client",
        clientSecret: "new-secret",
        clearClientSecret: false,
      }),
    );
  });

  it("drops hidden OAuth credentials when authorization switches to bearer", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Secure",
        serverKind: "personal",
      },
      {
        name: "Secure",
        transport: "http",
        urlOrCommand: "https://secure.example/mcp",
        authentication: "oauth",
        registrationMode: "preregistered",
        clientId: "old-client",
        clientSecret: "old-secret",
      },
    );

    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "new-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));

    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "bearer",
        clientId: "",
        clientSecret: undefined,
        clearClientSecret: true,
      }),
    );
  });

  it("requires a valid client ID before connecting with preregistered OAuth", async () => {
    const { onConnectOwnServer } = renderOverlay({
      status: "failed",
      serverName: "Secure",
      serverKind: "personal",
      error: "Connection refused",
    });
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://secure.example/mcp" },
    });
    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "OAuth" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Advanced Settings" }),
    );
    const registrationSelect = screen
      .getByText("Registration Strategy")
      .parentElement?.querySelector('[role="combobox"]');
    await userEvent.click(registrationSelect!);
    await userEvent.click(
      screen.getByRole("option", { name: /Preregistration/ }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByText("Client ID is required when using custom credentials"),
    ).toBeVisible();
    expect(onConnectOwnServer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "ab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      screen.getByText("Client ID must be at least 3 characters"),
    ).toBeVisible();
    expect(onConnectOwnServer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({ authentication: "oauth", clientId: "abc" }),
    );
  });

  it("does not reuse a recovered server identity for a new server", () => {
    const { onConnectOwnServer } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Notion",
        serverKind: "personal",
      },
      {
        name: "Notion",
        transport: "http",
        urlOrCommand: "https://mcp.notion.com/mcp",
        authentication: "oauth",
        oauthResourceUrl: "https://mcp.notion.com/mcp",
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit server details" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));

    expect(screen.getByLabelText("Server URL or command")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://multiaccount.mcpjam.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnectOwnServer).toHaveBeenCalledWith({
      name: "Multiaccount",
      transport: "http",
      urlOrCommand: "https://multiaccount.mcpjam.com/mcp",
      authentication: "auto",
    });
  });

  it("can select bearer authentication through the shared auth settings", async () => {
    const { onAuthorizeConnection, rerenderWithConnectionState } =
      renderOverlay({ status: "idle" });

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://secure.example/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    rerenderWithConnectionState({
      status: "authorization-required",
      serverName: "secure.example",
      serverKind: "personal",
      error: "401 Unauthorized",
    });
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));

    expect(onAuthorizeConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Secure",
        transport: "http",
        urlOrCommand: "https://secure.example/mcp",
        authentication: "bearer",
        bearerToken: "secret-token",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Authorization didn't finish",
    );
  });

  it("keeps authorization in place until a selected bearer token is provided", async () => {
    const { onAuthorizeConnection, rerenderWithConnectionState } =
      renderOverlay({ status: "idle" });

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://secure.example/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    rerenderWithConnectionState({
      status: "authorization-required",
      serverName: "Secure",
      serverKind: "personal",
      error: "401 Unauthorized",
    });

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));

    const tokenInput = screen.getByPlaceholderText("Enter your bearer token");
    expect(tokenInput).toHaveFocus();
    expect(tokenInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a bearer token to continue.")).toBeVisible();
    expect(onAuthorizeConnection).not.toHaveBeenCalled();
  });

  it("keeps XAA authorization in place until required credentials are provided", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Enterprise",
        serverKind: "personal",
        error: "XAA credentials are required",
      },
      {
        name: "Enterprise",
        transport: "http",
        urlOrCommand: "https://enterprise.example/mcp",
        authentication: "xaa",
        registrationMode: "preregistered",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));

    const clientId = screen.getByPlaceholderText(
      "Client ID registered with the server's authorization server",
    );
    expect(
      screen.getByText("Client ID is required when using custom credentials"),
    ).toBeVisible();
    await waitFor(() => expect(clientId).toHaveFocus());
    expect(onAuthorizeConnection).not.toHaveBeenCalled();
  });

  it("preserves XAA as a distinct authorization method", async () => {
    const { onAuthorizeConnection } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Enterprise",
        serverKind: "personal",
        error: "XAA credentials are required",
      },
      {
        name: "Enterprise",
        transport: "http",
        urlOrCommand: "https://enterprise.example/mcp",
        authentication: "xaa",
        registrationMode: "preregistered",
        clientId: "client-123",
      },
    );

    expect(
      await screen.findByText("Cross-App Access (XAA)"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: AUTHORIZE }));

    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "xaa",
        registrationMode: "preregistered",
        clientId: "client-123",
      }),
    );
  });

  it("keeps XAA settings available when editing server details", () => {
    const { onConnectOwnServer, rerenderWithConnectionState } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Enterprise",
        serverKind: "personal",
      },
      {
        name: "Enterprise",
        transport: "http",
        urlOrCommand: "https://enterprise.example/mcp",
        authentication: "xaa",
        registrationMode: "preregistered",
        clientId: "client-123",
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit server details" }),
    );
    rerenderWithConnectionState({ status: "idle" });
    expect(
      screen.getByRole("combobox", { name: "Authentication" }),
    ).toHaveTextContent("Cross-App Access (XAA)");
    expect(
      screen.getByPlaceholderText(
        "Client ID registered with the server's authorization server",
      ),
    ).toHaveValue("client-123");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "xaa",
        registrationMode: "preregistered",
        clientId: "client-123",
      }),
    );
  });

  it("probes confidential CIMD before the private XAA option is selected", async () => {
    renderOverlay(
      {
        status: "authorization-required",
        serverName: "Enterprise",
        serverKind: "personal",
      },
      {
        name: "Enterprise",
        transport: "http",
        urlOrCommand: "https://enterprise.example/mcp",
        authentication: "xaa",
        registrationMode: "cimd",
      },
    );

    await waitFor(() => expect(confidentialCimdProbe.enabled).toBe(true));
  });

  it("hides HTTP authentication for STDIO retries and drops stale bearer input", async () => {
    const { onConnectOwnServer } = renderOverlay({
      status: "failed",
      serverName: "Local",
      serverKind: "personal",
      error: "Connection refused",
    });
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "node server.js" },
    });
    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Bearer Token" }));
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "unused-token" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "stdio" }));

    expect(screen.queryByText("Authentication")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "stdio",
        authentication: "none",
        bearerToken: undefined,
      }),
    );
  });

  it("keeps sample-server failures out of the personal-server credential form", () => {
    const { onConnectDemo, onReturnToChoice, rerenderWithConnectionState } =
      renderOverlay();
    rerenderWithConnectionState({
      status: "failed",
      serverName: "Excalidraw (App)",
      serverKind: "demo",
      error: "Service unavailable",
    });

    expect(
      screen.getByRole("heading", { name: "Sample server unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The sample server didn't respond",
    );
    expect(screen.getByText("Service unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onConnectDemo).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect my own server" }),
    );
    expect(onReturnToChoice).toHaveBeenCalledOnce();
  });

  it("explains the connect step and offers the sample server", () => {
    renderOverlay();

    expect(
      screen.getByText(/MCPJam checks the connection, loads your tools/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Or start with a sample server" }),
    ).toBeInTheDocument();
    expect(screen.getByText("MCP App")).toBeInTheDocument();
    expect(screen.getByText("Not ready to connect a server?")).toBeVisible();
  });

  it("offers the shared authentication choices in editable server details", async () => {
    const { rerenderWithConnectionState } = renderOverlay();

    rerenderWithConnectionState({
      status: "failed",
      serverName: "Example",
      serverKind: "personal",
      error: "Connection refused",
    });

    await userEvent.click(
      screen.getByRole("combobox", { name: "Authentication" }),
    );
    expect(screen.getByRole("option", { name: "Auto" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "OAuth" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "No Authentication" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Bearer Token" }),
    ).toBeInTheDocument();
  });

  it("signals when the hydrated OAuth return modal is ready", () => {
    const onReady = vi.fn();
    window.addEventListener(FIRST_RUN_OAUTH_OVERLAY_READY_EVENT, onReady);

    renderOverlay({
      status: "connecting",
      serverName: "Multiaccount",
      serverKind: "personal",
    });

    expect(onReady).toHaveBeenCalledOnce();
    window.removeEventListener(FIRST_RUN_OAUTH_OVERLAY_READY_EVENT, onReady);
  });

  it("requires a server URL or command before opening the details sheet", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a server URL or command.",
    );
    expect(analyticsState.connectionFailed).toHaveBeenCalledWith(
      { serverKind: "personal" },
      "validation",
    );
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});

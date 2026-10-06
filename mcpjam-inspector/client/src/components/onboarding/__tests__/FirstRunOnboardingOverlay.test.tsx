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
const analyticsState = vi.hoisted(() => ({
  entered: vi.fn(),
  connectionFailed: vi.fn(),
  screenViewed: vi.fn(),
  setupLater: vi.fn(),
}));

vi.mock("framer-motion", () => ({
  useReducedMotion: () => motionState.reduced,
}));

vi.mock("@/lib/first-run-onboarding-analytics", () => ({
  trackFirstRunConnectionFailed: analyticsState.connectionFailed,
  trackFirstRunOnboardingEntered: analyticsState.entered,
  trackFirstRunOnboardingScreenViewed: analyticsState.screenViewed,
  trackFirstRunSetupLater: analyticsState.setupLater,
}));

import {
  FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS,
  FIRST_RUN_WELCOME_AUTO_ADVANCE_MS,
  FirstRunOnboardingOverlay,
  type FirstRunConnectionState,
  type FirstRunServerDraft,
} from "../FirstRunOnboardingOverlay";

function renderOverlay(
  connectionState: FirstRunConnectionState = { status: "idle" },
  skipWelcome = false,
  recoveryServerDraft?: FirstRunServerDraft,
  guestSessionRefused = false,
) {
  const onConnectOwnServer = vi.fn();
  const onConnectDemo = vi.fn();
  const onAuthorizeConnection = vi.fn();
  const onCancelConnection = vi.fn();
  const onReturnToChoice = vi.fn();
  const onOpenPlayground = vi.fn();
  const onWelcomeShown = vi.fn();
  const onSkip = vi.fn();
  const onSignIn = vi.fn();
  const view = render(
    <FirstRunOnboardingOverlay
      open
      skipWelcome={skipWelcome}
      connectionState={connectionState}
      recoveryServerDraft={recoveryServerDraft}
      onConnectOwnServer={onConnectOwnServer}
      onConnectDemo={onConnectDemo}
      onAuthorizeConnection={onAuthorizeConnection}
      onCancelConnection={onCancelConnection}
      onReturnToChoice={onReturnToChoice}
      onOpenPlayground={onOpenPlayground}
      onWelcomeShown={onWelcomeShown}
      onSkip={onSkip}
      guestSessionRefused={guestSessionRefused}
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
    onWelcomeShown,
    onSkip,
    onSignIn,
    rerenderWithConnectionState: (
      nextConnectionState: FirstRunConnectionState,
    ) =>
      view.rerender(
        <FirstRunOnboardingOverlay
          open
          skipWelcome={skipWelcome}
          connectionState={nextConnectionState}
          recoveryServerDraft={recoveryServerDraft}
          onConnectOwnServer={onConnectOwnServer}
          onConnectDemo={onConnectDemo}
          onAuthorizeConnection={onAuthorizeConnection}
          onCancelConnection={onCancelConnection}
          onReturnToChoice={onReturnToChoice}
          onOpenPlayground={onOpenPlayground}
          onWelcomeShown={onWelcomeShown}
          onSkip={onSkip}
          guestSessionRefused={guestSessionRefused}
          onSignIn={onSignIn}
        />,
      ),
  };
}

afterEach(() => {
  cleanup();
  motionState.reduced = false;
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
      true,
      undefined,
      true,
    );

    expect(screen.getByText("Guest session limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Try the Excalidraw demo server" }),
    ).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(onConnectDemo).not.toHaveBeenCalled();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
  });

  it("records the welcome when it is shown and can resume at server choice", () => {
    const { onWelcomeShown } = renderOverlay();
    expect(onWelcomeShown).toHaveBeenCalledOnce();

    cleanup();
    renderOverlay({ status: "idle" }, true);
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Welcome to MCPJam" }),
    ).not.toBeInTheDocument();
  });

  it("tracks entry once and each logical screen transition once", async () => {
    const { rerenderWithConnectionState } = renderOverlay();

    expect(analyticsState.entered).toHaveBeenCalledOnce();
    expect(analyticsState.entered).toHaveBeenCalledWith("welcome");
    expect(analyticsState.screenViewed).toHaveBeenLastCalledWith("welcome");

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
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
      renderOverlay(connectionState, true);

      expect(analyticsState.entered.mock.calls).toEqual([[expectedScreen]]);
      expect(analyticsState.screenViewed.mock.calls).toEqual([
        [expectedScreen],
      ]);
    },
  );

  it("tracks setup-later without form contents", () => {
    const { onSkip } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://private.example/mcp" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));

    expect(analyticsState.setupLater).toHaveBeenCalledOnce();
    expect(analyticsState.setupLater).toHaveBeenCalledWith();
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("advances from the welcome card with Get started", () => {
    renderOverlay();

    expect(
      document.querySelector('img[src="/mcp_jam.svg"]'),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "bg-background",
      "bg-[radial-gradient(ellipse_at_center,var(--background)_0%,var(--background)_42%,transparent_72%),radial-gradient(circle,var(--primary)_1px,transparent_1px)]",
      "bg-[size:auto,24px_24px]",
      "duration-700",
    );
    expect(
      screen.getByText(
        "Test and evaluate your MCP server for every user, across every major AI client.",
      ),
    ).toHaveClass("text-foreground");
    const continueButton = screen.getByRole("button", { name: "Get started" });
    expect(continueButton).toHaveClass(
      "justify-self-start",
      "bg-primary",
      "text-primary-foreground",
    );
    expect(continueButton).not.toHaveClass("underline");
    expect(continueButton).not.toHaveClass(
      "focus-visible:!border-0",
      "focus-visible:!ring-0",
    );

    fireEvent.click(continueButton);
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "backdrop-blur-sm",
    );
  });

  it("keeps its current step if eligibility briefly flickers", () => {
    const {
      view,
      onConnectOwnServer,
      onConnectDemo,
      onCancelConnection,
      onReturnToChoice,
      onOpenPlayground,
      onWelcomeShown,
      onSkip,
    } = renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
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
        onWelcomeShown={onWelcomeShown}
        onSkip={onSkip}
      />
    );

    view.rerender(renderWithOpen(false));
    view.rerender(renderWithOpen(true));

    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Welcome to MCPJam" }),
    ).not.toBeInTheDocument();
  });

  it("advances from the welcome card with Enter", () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();
  });

  it("automatically advances unless reduced motion is requested", () => {
    vi.useFakeTimers();
    renderOverlay();

    expect(screen.getByTestId("welcome-countdown-bar")).toHaveStyle({
      transitionDuration: `${FIRST_RUN_WELCOME_AUTO_ADVANCE_MS}ms`,
    });

    act(() => vi.advanceTimersByTime(FIRST_RUN_WELCOME_AUTO_ADVANCE_MS - 1));
    expect(
      screen.getByRole("heading", { name: "Welcome to MCPJam" }),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();

    cleanup();
    motionState.reduced = true;
    renderOverlay();
    act(() => vi.advanceTimersByTime(FIRST_RUN_WELCOME_AUTO_ADVANCE_MS));
    expect(
      screen.getByRole("heading", { name: "Welcome to MCPJam" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-countdown")).not.toBeInTheDocument();
  });

  it("delegates both connection paths and the explicit skip", () => {
    const {
      onConnectOwnServer,
      onConnectDemo,
      onReturnToChoice,
      onSkip,
      rerenderWithConnectionState,
    } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

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
      screen.getByRole("heading", { name: "Set up your server" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to connect to MCP server",
    );
    expect(screen.queryByText("Connection refused")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View technical details" }),
    );
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide technical details" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(screen.getByText("Enter a server URL or command.")).toBeVisible();
    expect(onConnectOwnServer).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "  https://mcp.example.com/mcp  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(onConnectOwnServer).toHaveBeenCalledTimes(2);
    expect(onConnectOwnServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Example",
        transport: "http",
        urlOrCommand: "https://mcp.example.com/mcp",
        authentication: "auto",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onReturnToChoice).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Try the Excalidraw demo server",
      }),
    );
    expect(onConnectDemo).toHaveBeenCalledOnce();

    const setUpLaterButton = screen.getByRole("button", {
      name: "Set up later",
    });
    expect(setUpLaterButton).toHaveClass("text-foreground");
    expect(setUpLaterButton).not.toHaveClass("underline");
    fireEvent.click(setUpLaterButton);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("dismisses the server-choice modal from its close control", () => {
    const { onSkip } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    fireEvent.click(screen.getByRole("button", { name: "Close onboarding" }));

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
    expect(screen.getByText("Connect server")).toBeInTheDocument();
    expect(screen.getByText("Negotiate MCP compatibility")).toBeInTheDocument();
    expect(screen.getByText("Load tools")).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toHaveClass("text-foreground");
    expect(cancelButton).not.toHaveClass("underline");
    fireEvent.click(cancelButton);
    expect(onCancelConnection).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Connect to your MCP server" }),
    ).toBeInTheDocument();

    rerenderWithConnectionState({
      status: "loading-tools",
      serverName: "My server",
      serverKind: "personal",
    });
    expect(screen.getByText("Load tools").closest("li")).toHaveClass(
      "text-left",
    );
    expect(
      screen.getByText("Connect server").parentElement?.querySelector("svg"),
    ).toHaveClass("text-success");

    rerenderWithConnectionState({
      status: "connected",
      serverName: "My server",
      serverKind: "personal",
      toolCount: 3,
    });
    act(() => {
      vi.advanceTimersByTime(FIRST_RUN_CONNECTION_SUCCESS_REVEAL_MS);
    });
    expect(
      screen.getByRole("heading", { name: "Connected to My server" }),
    ).toBeInTheDocument();
    expect(screen.getByText("My server")).toHaveClass("text-card-foreground");
    expect(screen.getByTestId("first-run-success-indicator")).toHaveClass(
      "border-success",
      "bg-success",
      "text-success-foreground",
      "animate-in",
    );
    expect(screen.getByText("3 tools ready to use.")).toBeInTheDocument();

    rerenderWithConnectionState({
      status: "connected",
      serverName: "My server",
      serverKind: "personal",
      toolCount: null,
    });
    expect(
      screen.getByText("Connected. Tools can finish loading in Playground."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Playground" }));
    expect(onOpenPlayground).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("expands OAuth authorization recovery within connection progress", () => {
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
      screen.getByRole("heading", {
        name: "Connecting to Multiaccount",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your server needs authorization to connect."),
    ).toBeInTheDocument();
    expect(screen.getByText("Connect server")).toHaveClass("text-destructive");
    expect(screen.getByText("Authentication")).toBeInTheDocument();
    const failedConnectionStep = screen.getByRole("button", {
      name: "Connect server",
    });
    expect(failedConnectionStep).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(failedConnectionStep);
    expect(screen.queryByText("Authentication")).not.toBeInTheDocument();
    fireEvent.click(failedConnectionStep);
    expect(screen.getByText("Authentication")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Advanced Settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit server details" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
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
      screen.getByRole("heading", { name: "Set up your server" }),
    ).toBeInTheDocument();
  });

  it("restores saved server details before editing a remounted OAuth recovery", () => {
    const { rerenderWithConnectionState } = renderOverlay(
      {
        status: "authorization-required",
        serverName: "Multiaccount",
        serverKind: "personal",
      },
      true,
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(
      screen.getByText("Enter a bearer token to continue."),
    ).toBeInTheDocument();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(
      screen.getByText("Enter a bearer token to continue."),
    ).toBeInTheDocument();
    expect(onConnectOwnServer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Enter your bearer token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
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
        true,
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
          name: status === "failed" ? "Connect server" : "Authorize",
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
    const { onConnectOwnServer } = renderOverlay(
      {
        status: "failed",
        serverName: "Secure",
        serverKind: "personal",
        error: "Connection refused",
      },
      true,
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
    expect(onAuthorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "new-client",
        clientSecret: undefined,
        clearClientSecret: true,
      }),
    );
  });

  it("keeps newly entered credentials after switching registration modes", async () => {
    const { onConnectOwnServer } = renderOverlay(
      {
        status: "failed",
        serverName: "Secure",
        serverKind: "personal",
        error: "Connection refused",
      },
      true,
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

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
    const { onConnectOwnServer } = renderOverlay(
      {
        status: "failed",
        serverName: "Secure",
        serverKind: "personal",
        error: "Connection refused",
      },
      true,
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(
      screen.getByText("Client ID is required when using custom credentials"),
    ).toBeVisible();
    expect(onConnectOwnServer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "ab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(
      screen.getByText("Client ID must be at least 3 characters"),
    ).toBeVisible();
    expect(onConnectOwnServer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Your OAuth Client ID"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

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
      renderOverlay({ status: "idle" }, true);

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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

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
      "Failed to connect to MCP server",
    );
  });

  it("keeps authorization in place until a selected bearer token is provided", async () => {
    const { onAuthorizeConnection, rerenderWithConnectionState } =
      renderOverlay({ status: "idle" }, true);

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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

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
      true,
      {
        name: "Enterprise",
        transport: "http",
        urlOrCommand: "https://enterprise.example/mcp",
        authentication: "xaa",
        registrationMode: "preregistered",
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

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
      true,
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
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication: "xaa",
        registrationMode: "preregistered",
        clientId: "client-123",
      }),
    );
  });

  it("keeps demo failures out of the personal-server credential form", () => {
    const { onConnectDemo, onReturnToChoice, rerenderWithConnectionState } =
      renderOverlay();
    rerenderWithConnectionState({
      status: "failed",
      serverName: "Excalidraw (App)",
      serverKind: "demo",
      error: "Service unavailable",
    });

    expect(
      screen.getByRole("heading", { name: "Demo server unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Set up your server" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect my own server" }),
    ).toHaveTextContent("Connect my own server");
    expect(
      screen.getByRole("button", { name: "Connect my own server" })
        .parentElement,
    ).toHaveClass("flex", "justify-center");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to connect to MCP server",
    );
    expect(screen.queryByText("Service unavailable")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View technical details" }),
    );
    expect(screen.getByText("Service unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try demo again" }));
    expect(onConnectDemo).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect my own server" }),
    );
    expect(onReturnToChoice).toHaveBeenCalledOnce();
  });

  it("uses the prototype's welcome and server-choice copy", () => {
    renderOverlay();

    expect(
      screen.getByText(
        /Test and evaluate your MCP server for every user, across every major AI client/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(
      screen.getByText(
        /Add your MCP server to get started, or start testing with our demo server/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No setup · nothing to install"),
    ).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a server URL or command.",
    );
    expect(analyticsState.connectionFailed).toHaveBeenCalledWith(
      { serverKind: "personal" },
      "validation",
    );
    expect(
      screen.queryByRole("heading", { name: "Set up your server" }),
    ).not.toBeInTheDocument();
  });
});

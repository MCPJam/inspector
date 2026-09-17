import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const motionState = vi.hoisted(() => ({ reduced: false }));

vi.mock("framer-motion", () => ({
  useReducedMotion: () => motionState.reduced,
}));

import {
  FIRST_RUN_WELCOME_AUTO_ADVANCE_MS,
  FirstRunOnboardingOverlay,
  type FirstRunConnectionState,
} from "../FirstRunOnboardingOverlay";

function renderOverlay(
  connectionState: FirstRunConnectionState = { status: "idle" },
  skipWelcome = false,
) {
  const onConnectOwnServer = vi.fn();
  const onConnectDemo = vi.fn();
  const onCancelConnection = vi.fn();
  const onReturnToChoice = vi.fn();
  const onOpenPlayground = vi.fn();
  const onWelcomeShown = vi.fn();
  const onSkip = vi.fn();
  const view = render(
    <FirstRunOnboardingOverlay
      open
      skipWelcome={skipWelcome}
      connectionState={connectionState}
      onConnectOwnServer={onConnectOwnServer}
      onConnectDemo={onConnectDemo}
      onCancelConnection={onCancelConnection}
      onReturnToChoice={onReturnToChoice}
      onOpenPlayground={onOpenPlayground}
      onWelcomeShown={onWelcomeShown}
      onSkip={onSkip}
    />,
  );
  return {
    view,
    onConnectOwnServer,
    onConnectDemo,
    onCancelConnection,
    onReturnToChoice,
    onOpenPlayground,
    onWelcomeShown,
    onSkip,
    rerenderWithConnectionState: (
      nextConnectionState: FirstRunConnectionState,
    ) =>
      view.rerender(
        <FirstRunOnboardingOverlay
          open
          skipWelcome={skipWelcome}
          connectionState={nextConnectionState}
          onConnectOwnServer={onConnectOwnServer}
          onConnectDemo={onConnectDemo}
          onCancelConnection={onCancelConnection}
          onReturnToChoice={onReturnToChoice}
          onOpenPlayground={onOpenPlayground}
          onWelcomeShown={onWelcomeShown}
          onSkip={onSkip}
        />,
      ),
  };
}

afterEach(() => {
  cleanup();
  motionState.reduced = false;
  vi.useRealTimers();
});

describe("FirstRunOnboardingOverlay", () => {
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
    expect(onConnectOwnServer).toHaveBeenLastCalledWith({
      name: "Example",
      transport: "http",
      urlOrCommand: "https://mcp.example.com/mcp",
      authentication: "auto",
    });

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
    expect(screen.getByText("Reach server")).toBeInTheDocument();
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
    expect(screen.getByText("Load tools").parentElement).toHaveClass(
      "text-left",
    );
    expect(
      screen.getByText("Reach server").parentElement?.querySelector("svg"),
    ).toHaveClass("text-success");

    rerenderWithConnectionState({
      status: "connected",
      serverName: "My server",
      serverKind: "personal",
      toolCount: 3,
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

  it("only offers credential modes that the onboarding form can submit", () => {
    const { rerenderWithConnectionState } = renderOverlay();

    rerenderWithConnectionState({
      status: "failed",
      serverName: "Example",
      serverKind: "personal",
      error: "Connection refused",
    });

    expect(screen.getByRole("option", { name: "Auto" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "OAuth" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Bearer token" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Header")).not.toBeInTheDocument();
  });

  it("requires a server URL or command before opening the details sheet", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a server URL or command.",
    );
    expect(
      screen.queryByRole("heading", { name: "Set up your server" }),
    ).not.toBeInTheDocument();
  });
});

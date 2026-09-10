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
} from "../FirstRunOnboardingOverlay";

function renderOverlay(connectionState = { status: "idle" } as const) {
  const onConnectOwnServer = vi.fn();
  const onConnectDemo = vi.fn();
  const onSkip = vi.fn();
  const view = render(
    <FirstRunOnboardingOverlay
      open
      connectionState={connectionState}
      onConnectOwnServer={onConnectOwnServer}
      onConnectDemo={onConnectDemo}
      onSkip={onSkip}
    />,
  );
  return {
    onConnectOwnServer,
    onConnectDemo,
    onSkip,
    rerenderWithConnectionState: (
      nextConnectionState:
        | { status: "idle" }
        | { status: "preparing"; serverName: string }
        | { status: "connecting"; serverName: string }
        | { status: "failed"; error: string },
    ) =>
      view.rerender(
        <FirstRunOnboardingOverlay
          open
          connectionState={nextConnectionState}
          onConnectOwnServer={onConnectOwnServer}
          onConnectDemo={onConnectDemo}
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
  it("advances from the welcome card with Continue", () => {
    renderOverlay();

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toHaveClass(
      "justify-self-start",
      "focus-visible:!border-0",
      "focus-visible:!ring-0",
    );

    fireEvent.click(continueButton);
    expect(
      screen.getByRole("heading", { name: "Point MCPJam at a server" }),
    ).toBeInTheDocument();
  });

  it("advances from the welcome card with Enter", () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(
      screen.getByRole("heading", { name: "Point MCPJam at a server" }),
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
      screen.getByRole("heading", { name: "Point MCPJam at a server" }),
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
      onSkip,
      rerenderWithConnectionState,
    } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(screen.getByLabelText("Server URL or command"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnectOwnServer).toHaveBeenCalledWith({
      name: "Example",
      transport: "http",
      urlOrCommand: "https://mcp.example.com/mcp",
      authentication: "auto",
      header: "",
    });

    rerenderWithConnectionState({
      status: "failed",
      error: "Connection refused",
    });
    expect(
      screen.getByRole("heading", { name: "Set up your server" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
    fireEvent.click(screen.getByRole("button", { name: "Connect server" }));
    expect(onConnectOwnServer).toHaveBeenCalledTimes(2);
    expect(onConnectOwnServer).toHaveBeenLastCalledWith({
      name: "Example",
      transport: "http",
      urlOrCommand: "https://mcp.example.com/mcp",
      authentication: "auto",
      header: "",
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Try the Excalidraw demo server",
      }),
    );
    expect(onConnectDemo).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("shows project preparation separately from the MCP handshake", () => {
    const { rerenderWithConnectionState } = renderOverlay();

    rerenderWithConnectionState({
      status: "preparing",
      serverName: "Excalidraw (App)",
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

  it("uses the prototype's welcome and server-choice copy", () => {
    renderOverlay();

    expect(
      screen.getByText(
        /From your first prompt to a continuous gate on every release/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText(
        /lets you call its tools, inspect traces, and see how different clients handle it/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("6 tools · no setup · nothing to install"),
    ).toBeInTheDocument();
  });

  it("requires a server URL or command before opening the details sheet", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a server URL or command.",
    );
    expect(
      screen.queryByRole("heading", { name: "Set up your server" }),
    ).not.toBeInTheDocument();
  });
});

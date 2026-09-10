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

function renderOverlay() {
  const onConnectOwnServer = vi.fn();
  const onConnectDemo = vi.fn();
  const onSkip = vi.fn();
  render(
    <FirstRunOnboardingOverlay
      open
      onConnectOwnServer={onConnectOwnServer}
      onConnectDemo={onConnectDemo}
      onSkip={onSkip}
    />,
  );
  return { onConnectOwnServer, onConnectDemo, onSkip };
}

afterEach(() => {
  cleanup();
  motionState.reduced = false;
  vi.useRealTimers();
});

describe("FirstRunOnboardingOverlay", () => {
  it("advances from the welcome card with Continue", () => {
    renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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
    const { onConnectOwnServer, onConnectDemo, onSkip } = renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Connect your server" }),
    );
    expect(onConnectOwnServer).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Try the Excalidraw demo server",
      }),
    );
    expect(onConnectDemo).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "I'll set this up later" }),
    );
    expect(onSkip).toHaveBeenCalledOnce();
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
});

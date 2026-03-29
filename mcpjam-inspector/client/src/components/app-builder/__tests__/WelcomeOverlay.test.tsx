import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// Mock framer-motion
vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
  >(function MotionDiv(props, ref) {
    const {
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    } = props;
    return <div ref={ref} {...rest} />;
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: { div: MotionDiv },
  };
});

// Mock preferences store
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: any) => {
    const state = { themeMode: "light" };
    return selector ? selector(state) : state;
  },
}));

import { WelcomeOverlay } from "../WelcomeOverlay";

describe("WelcomeOverlay", () => {
  const defaultProps = {
    phase: "welcome" as const,
    connectError: null,
    onConnectExcalidraw: vi.fn(),
    onRetry: vi.fn(),
  };

  it("renders the demo options without a skip action", () => {
    render(<WelcomeOverlay {...defaultProps} />);

    expect(
      screen.getByRole("dialog", { name: "Try a demo server" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Try a demo server")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Skip onboarding/i }),
    ).not.toBeInTheDocument();
  });

  it("renders only the Excalidraw CTA in the default state", () => {
    render(<WelcomeOverlay {...defaultProps} />);

    expect(
      screen.getByRole("button", { name: /Connect Excalidraw/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Browse Registry/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add server manually/i }),
    ).not.toBeInTheDocument();
  });

  it("shows loading state when connecting", () => {
    render(<WelcomeOverlay {...defaultProps} phase="connecting_excalidraw" />);

    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("shows error state with retry button", () => {
    render(
      <WelcomeOverlay
        {...defaultProps}
        phase="connect_error"
        connectError="Connection timed out"
      />,
    );

    expect(screen.getByText("Connection timed out")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Retry Excalidraw/i }),
    ).toBeInTheDocument();
  });

  it("calls onConnectExcalidraw when primary button is clicked", () => {
    render(<WelcomeOverlay {...defaultProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: /Connect Excalidraw/i }),
    );
    expect(defaultProps.onConnectExcalidraw).toHaveBeenCalled();
  });

  it("does not dismiss on Escape key", () => {
    render(<WelcomeOverlay {...defaultProps} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: /Connect Excalidraw/i }),
    ).toBeInTheDocument();
  });
});

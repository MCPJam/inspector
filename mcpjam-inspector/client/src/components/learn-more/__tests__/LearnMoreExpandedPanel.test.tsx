import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", async () => {
  const React = await import("react");

  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }
  >(function MotionDiv(
    {
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    },
    ref,
  ) {
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    );
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: {
      div: MotionDiv,
    },
  };
});

import {
  getLearnMorePanelLayout,
  LearnMoreExpandedPanel,
} from "../LearnMoreExpandedPanel";

describe("LearnMoreExpandedPanel", () => {
  it("keeps the panel centered within viewport gutters on narrow screens", () => {
    expect(getLearnMorePanelLayout(700, 900)).toMatchObject({
      left: 16,
      width: 668,
    });

    expect(getLearnMorePanelLayout(1400, 900)).toMatchObject({
      left: 250,
      width: 900,
    });
  });

  it("renders the expanded description when available", () => {
    render(
      <LearnMoreExpandedPanel
        tabId="servers"
        sourceRect={null}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /Connect to MCP servers using STDIO, SSE, or Streamable HTTP\./i,
      ),
    ).toBeInTheDocument();
  });

  it("closes when Escape is pressed", () => {
    const onClose = vi.fn();

    render(
      <LearnMoreExpandedPanel
        tabId="skills"
        sourceRect={null}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("lets keyboard users start playback from the play button", async () => {
    const user = userEvent.setup();

    render(
      <LearnMoreExpandedPanel
        tabId="servers"
        sourceRect={null}
        onClose={vi.fn()}
      />,
    );

    const playButton = screen.getByRole("button", {
      name: "Play Servers video",
    });

    playButton.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTitle("Servers video")).toBeInTheDocument();
  });
});

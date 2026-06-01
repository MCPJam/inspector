import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
  >(function MotionDiv(props, ref) {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    } = props;

    return <div ref={ref} {...rest} />;
  });

  return {
    motion: { div: MotionDiv },
  };
});

import { PostConnectGuide } from "../PostConnectGuide";

describe("PostConnectGuide", () => {
  it("renders the guided prompt copy", () => {
    render(<PostConnectGuide />);

    expect(
      screen.getByText("Try asking Excalidraw to draw something."),
    ).toBeInTheDocument();
  });
});

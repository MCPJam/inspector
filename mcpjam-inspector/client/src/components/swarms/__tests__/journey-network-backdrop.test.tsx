import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyNetworkBackdrop } from "../journey-network-backdrop";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    createRadialGradient: vi.fn(() => ({
      addColorStop: vi.fn(),
    })),
    measureText: vi.fn(() => ({ width: 40 })),
    fillText: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe("JourneyNetworkBackdrop", () => {
  it("renders the empty-state message over the network canvas", () => {
    render(<JourneyNetworkBackdrop />);

    expect(
      screen.getByText("Select a persona to see its journeys."),
    ).toBeTruthy();
    expect(screen.getByTestId("journey-network-backdrop")).toBeTruthy();
    expect(
      screen.getByTestId("journey-network-backdrop").querySelector("canvas"),
    ).toBeTruthy();
  });

  it("accepts a custom message", () => {
    render(<JourneyNetworkBackdrop message="Pick someone to continue." />);
    expect(screen.getByText("Pick someone to continue.")).toBeTruthy();
  });
});

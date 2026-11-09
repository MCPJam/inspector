import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConformanceRunHeader } from "../ConformanceRunHeader";

function renderHeader(
  overrides: Partial<Parameters<typeof ConformanceRunHeader>[0]> = {},
) {
  const props = {
    serverName: "bart",
    startedAt: Date.UTC(2026, 10, 4, 12, 0),
    backLabel: "Conformance",
    onBack: vi.fn(),
    busy: false,
    isConnecting: false,
    showHistory: true,
    onOpenSettings: vi.fn(),
    showShare: false,
    onRunAgain: vi.fn(),
    runDisabled: false,
    ...overrides,
  };
  render(<ConformanceRunHeader {...props} />);
  return props;
}

describe("ConformanceRunHeader", () => {
  it("leads back to Conformance and shows no Overview/History tabs", () => {
    const props = renderHeader();

    expect(screen.getByRole("heading", { name: "bart" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conformance" }));
    expect(props.onBack).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("keeps Settings, Share and Run again on the right", () => {
    const props = renderHeader({ showShare: true });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    // Not saved yet, so Share waits.
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(props.onRunAgain).toHaveBeenCalledTimes(1);
  });

  it("does not let the user leave while the run is going", () => {
    renderHeader({ busy: true });

    expect(screen.getByRole("button", { name: "Conformance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
  });

  it("keeps a finished run on screen when there is no History to find it in", () => {
    renderHeader({ showHistory: false });

    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.getByRole("button", { name: "Conformance" })).toBeDisabled();
  });
});

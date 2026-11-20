import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { navigateMock, trackMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => navigateMock };
});

vi.mock("@/lib/analytics", () => ({ track: trackMock }));

import { CheckConformanceButton } from "../CheckConformanceButton";

describe("CheckConformanceButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens Conformance with a run on this server", () => {
    render(<CheckConformanceButton serverName="weather server" />);

    fireEvent.click(screen.getByRole("button", { name: "Check conformance" }));

    // The Conformance page starts a run on `?run=<server>` and drops the key.
    expect(navigateMock).toHaveBeenCalledWith(
      "/conformance?run=weather+server",
    );
    expect(trackMock).toHaveBeenCalledWith("check_conformance_clicked", {
      location: "server_connection_card",
    });
  });

  it("does not also open the card it sits on", () => {
    const openCard = vi.fn();
    render(
      <div onClick={openCard}>
        <CheckConformanceButton serverName="weather" />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Check conformance" }));

    expect(openCard).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });
});

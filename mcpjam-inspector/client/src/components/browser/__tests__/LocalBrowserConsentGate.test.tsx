import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocalBrowserConsentGate } from "../LocalBrowserConsentGate";

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

describe("LocalBrowserConsentGate", () => {
  it("names Browser Use and WebMCP without a long consent lecture", () => {
    render(<LocalBrowserConsentGate onAllow={() => true} />);

    expect(
      screen.getByRole("heading", {
        name: "MCPJam supports Browser Use and WebMCP",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Allow a browser on this machine/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Allow agents to control a browser/i),
    ).toBeNull();
    expect(screen.queryByText(/Shell permission/i)).toBeNull();
    expect(screen.queryByText(/Tool Approval/i)).toBeNull();
  });
});

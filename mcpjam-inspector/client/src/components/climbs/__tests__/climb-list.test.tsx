import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listClimbs = vi.fn();
// A plain function for the failing case: the runner counts a spy's rejected copy as unhandled.
let refusal: Error | undefined;
vi.mock("@/lib/apis/climbs-api", () => ({
  listClimbs: async (...a: unknown[]) => {
    const answer = listClimbs(...a);
    if (refusal) throw refusal;
    return answer;
  },
}));

import { ClimbList } from "../climb-list";

const show = () => {
  const props = { onOpen: vi.fn(), onStart: vi.fn() };
  render(<ClimbList projectId="proj_1" suiteId="suite_1" {...props} />);
  return props;
};

beforeEach(() => {
  listClimbs.mockReset();
  refusal = undefined;
});

describe("ClimbList", () => {
  it("lists the suite's climbs and opens one", async () => {
    listClimbs.mockResolvedValue([
      { climbId: "c1", suiteId: "suite_1", serverName: "mcpjam-mcp", state: "running", measure: "pass_rate", roundsStarted: 4, roundLimit: 10, createdAt: Date.UTC(2026, 10, 22) },
      { climbId: "c2", suiteId: "suite_1", serverName: "stateless", state: "stopped", measure: "tokens", roundsStarted: 2, roundLimit: 5, createdAt: Date.UTC(2026, 10, 20) },
    ]);
    const props = show();
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText("4 of 10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(props.onOpen).toHaveBeenCalledWith("c2");
  });
  it("starts a climb from the button", async () => {
    listClimbs.mockResolvedValue([]);
    const props = show();
    expect(await screen.findByText(/No climbs yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Start a climb/ }));
    expect(props.onStart).toHaveBeenCalled();
  });
  it("says it is loading, and says what failed with a way to try again", async () => {
    listClimbs.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<ClimbList projectId="p" suiteId="s" onOpen={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading climbs.");
    unmount();
    refusal = new Error("Climbs are not turned on for this account yet. Ask an MCPJam admin to enable them.");
    show();
    expect(await screen.findByText(/not turned on for this account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

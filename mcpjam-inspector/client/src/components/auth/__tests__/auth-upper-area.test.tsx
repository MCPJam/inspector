import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const authState: { user: { id: string } | null } = { user: null };

vi.mock("@/hooks/use-inspector-auth", () => ({
  useInspectorAuth: () => ({
    user: authState.user,
    signIn: vi.fn(),
    signUp: vi.fn(),
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false }),
}));
vi.mock("@/components/ui/github-star-button", () => ({
  GitHubStarButton: () => <button type="button">Star</button>,
}));
vi.mock("@/components/mcpjam-agent/AgentSidePanelTrigger", () => ({
  AgentSidePanelTrigger: () => null,
}));
vi.mock("@/components/onboard-agent/OnboardAgentButton", () => ({
  OnboardAgentButton: () => <button type="button">Onboard</button>,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { AuthUpperArea } from "../auth-upper-area";

describe("AuthUpperArea", () => {
  beforeEach(() => {
    authState.user = null;
  });

  it("hides the Onboard button when signed out", () => {
    render(<AuthUpperArea />);
    expect(screen.queryByRole("button", { name: "Onboard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the Onboard button when signed in", () => {
    authState.user = { id: "user_1" };
    render(<AuthUpperArea />);
    expect(screen.getByRole("button", { name: "Onboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("puts Sign in and Create account rightmost when signed out", () => {
    render(<AuthUpperArea />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.slice(-3)).toEqual(["Star", "Sign in", "Create account"]);
  });
});

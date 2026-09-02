import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import { ScenarioShareEmptyPanel } from "../ScenarioShareEmptyPanel";

const {
  authState,
  upsertScenarioMemberMock,
  copyToClipboardMock,
} = vi.hoisted(() => ({
  authState: { isAuthenticated: true },
  upsertScenarioMemberMock: vi.fn().mockResolvedValue(undefined),
  copyToClipboardMock: vi.fn(async () => true),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => authState,
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => ({
    upsertScenarioMember: upsertScenarioMemberMock,
  }),
}));

vi.mock("@/lib/scenario-session", () => ({
  buildScenarioLink: (token: string) => `https://mcpjam.link/t/${token}`,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => copyToClipboardMock(...args),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const scenario = {
  scenarioId: "cb-1",
  name: "Payments beta",
  link: { token: "tok", path: "/t/tok", url: "u", rotatedAt: 0, updatedAt: 0 },
} as unknown as ScenarioSettings;

beforeEach(() => {
  vi.clearAllMocks();
  authState.isAuthenticated = true;
  upsertScenarioMemberMock.mockResolvedValue(undefined);
  copyToClipboardMock.mockResolvedValue(true);
});

describe("ScenarioShareEmptyPanel", () => {
  it("offers both a self-serve run and the share actions", () => {
    render(<ScenarioShareEmptyPanel scenario={scenario} />);

    expect(screen.getByTestId("user-testing-share-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Insights start with the first session/i),
    ).toBeInTheDocument();
    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
    expect(screen.getByText(/Try it yourself/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite by email" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
    const preview = screen.getByTestId("user-testing-share-empty-preview");
    expect(preview).toHaveAttribute("href", "https://mcpjam.link/t/tok");
    expect(preview).toHaveAttribute("target", "_blank");
  });

  it("does not restate the header's share headline", () => {
    render(<ScenarioShareEmptyPanel scenario={scenario} />);

    expect(
      screen.queryByText(/Share this with customers/i),
    ).not.toBeInTheDocument();
  });

  it("replaces the run affordance when the environment can't resolve", () => {
    render(
      <ScenarioShareEmptyPanel
        scenario={
          {
            ...scenario,
            environmentError: {
              code: "ENV_ARCHIVED",
              message: "Environment archived.",
            },
          } as ScenarioSettings
        }
      />,
    );

    expect(
      screen.queryByTestId("user-testing-share-empty-preview"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-share-empty-blocked"),
    ).toHaveTextContent(/environment isn't resolving/i);
  });

  it("still shows the link when unauthenticated, without invite", () => {
    authState.isAuthenticated = false;
    render(<ScenarioShareEmptyPanel scenario={scenario} />);

    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Invite by email" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
  });

  it("copies the share link from the empty panel", async () => {
    render(<ScenarioShareEmptyPanel scenario={scenario} />);

    fireEvent.click(screen.getByTestId("user-testing-share-empty-copy"));

    await waitFor(() =>
      expect(copyToClipboardMock).toHaveBeenCalledWith(
        "https://mcpjam.link/t/tok",
      ),
    );
  });
});

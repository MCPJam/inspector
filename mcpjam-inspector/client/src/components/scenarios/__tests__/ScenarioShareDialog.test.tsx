import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import { ScenarioShareDialog } from "../ScenarioShareDialog";

const scenarioMutations = vi.hoisted(() => ({
  setScenarioMode: vi.fn(),
  updateScenario: vi.fn(),
  upsertScenarioMember: vi.fn(),
  removeScenarioMember: vi.fn(),
  rotateScenarioLink: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { firstName: "Test", lastName: "User", email: "test@example.com" },
  }),
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => scenarioMutations,
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/toast", () => ({ toast }));

const scenario = {
  scenarioId: "cb-1",
  projectId: "ws-1",
  name: "My Scenario",
  hostStyle: "chatgpt",
  systemPrompt: "",
  modelId: "gpt-4",
  temperature: 0.7,
  requireToolApproval: false,
  allowGuestAccess: false,
  mode: "invited_only",
  servers: [],
  link: {
    token: "t",
    path: "/c/t",
    url: "https://example.com/c/t",
    rotatedAt: 0,
    updatedAt: 0,
  },
  members: [],
} as unknown as ScenarioSettings;

describe("ScenarioShareDialog", () => {
  it("renders link, invite, and access — the three sharing steps", () => {
    render(
      <ScenarioShareDialog
        scenario={scenario}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(
      screen.getByText("Share this study with your users"),
    ).toBeInTheDocument();
    expect(screen.getByText("Tester link")).toBeInTheDocument();
    expect(
      screen.getByTestId("scenario-copy-tester-link"),
    ).toBeInTheDocument();
    expect(screen.getByText("Invite with email")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Add people, emails..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Access settings")).toBeInTheDocument();
  });

  it("leaves roster and link rotation to the settings page", () => {
    render(
      <ScenarioShareDialog
        scenario={scenario}
        open
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryByText("Has access")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scenario-share-link-menu")).toBeNull();
  });

  it("renders nothing while closed", () => {
    render(
      <ScenarioShareDialog
        scenario={scenario}
        open={false}
        onOpenChange={() => undefined}
      />,
    );

    expect(
      screen.queryByText("Share this study with your users"),
    ).not.toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSettings } from "@/hooks/useScenarios";
import { ScenarioShareSection } from "../ScenarioShareSection";

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
    user: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
    },
  }),
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenarioMutations: () => scenarioMutations,
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/toast", () => ({ toast }));

function createScenario(overrides: Partial<ScenarioSettings> = {}): ScenarioSettings {
  return {
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
    ...overrides,
  };
}

describe("ScenarioShareSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the same section structure as the project share dialog", () => {
    render(
      <ScenarioShareSection scenario={createScenario()} projectName="Acme" />,
    );

    // getByLabelText, not getByText: the "Tester link" label has to resolve to
    // a real labelable control, so the link reads as that label's value to
    // assistive tech instead of as unassociated text.
    // The path says User Testing too — the tester reads this URL, and a code
    // name in it is what SUTB-8 reported.
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "/user-testing/my-scenario/t",
    );
    expect(screen.getByTestId("scenario-copy-tester-link")).toBeInTheDocument();
    expect(screen.getByText("Invite with email")).toBeInTheDocument();
    expect(screen.getByText("Access settings")).toBeInTheDocument();
    expect(screen.getByText("Has access")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Invite", exact: true }),
    ).toBeInTheDocument();
  });

  // Opening a scenario to anyone with the link puts guest usage on the
  // organization's credits. There is no per-scenario cap editor any more (the
  // platform daily ceilings are the brake), so this line is the only place
  // that cost is disclosed — and it has to appear exactly where the exposure
  // is chosen.
  it("discloses guest credit usage only when link guest access is selected", () => {
    const creditNotice = /Guest usage runs on your organization's credits/i;
    const { rerender } = render(
      <ScenarioShareSection scenario={createScenario()} projectName="Acme" />,
    );

    expect(screen.queryByText(creditNotice)).not.toBeInTheDocument();

    rerender(
      <ScenarioShareSection
        scenario={createScenario({
          allowGuestAccess: true,
          mode: "anyone_with_link",
        })}
        projectName="Acme"
      />,
    );

    expect(screen.getByText(creditNotice)).toBeInTheDocument();
  });

  /**
   * The other end of "a scenario that cannot run must not be shareable": the
   * create flow refuses to publish without an environment, and a scenario whose
   * environment stops resolving stops issuing its link. Without this the amber
   * banner on the detail page sat next to a live Copy link button, so the only
   * person who found out was the tester who opened it.
   */
  it("withholds the tester link while the environment can't resolve", () => {
    const scenario = createScenario({
      environmentId: "env-1",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "This scenario's environment was archived.",
      },
    });

    render(<ScenarioShareSection scenario={scenario} projectName="Acme" />);

    // The withheld copy, not just the absence of the link: asserting a path is
    // missing would stay green if the path shape ever changed under it.
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "Withheld — this scenario can't run.",
    );
    expect(screen.getByTestId("scenario-copy-tester-link")).toBeDisabled();
    // Inviting mails the same link out, so it is gated too.
    expect(
      screen.getByRole("button", { name: "Invite", exact: true }),
    ).toBeDisabled();
    // The backend's own reason, verbatim: "archived" and "its host is gone" send
    // the owner to different places.
    expect(screen.getByTestId("scenario-share-unrunnable")).toHaveTextContent(
      "This scenario's environment was archived.",
    );
  });

  // A rebind is a legitimate way out of that state, so the gate has to be
  // derived from the live envelope rather than latched: the same token comes
  // back the moment the scenario points at an environment that resolves.
  it("issues the link again once the environment resolves", () => {
    const { rerender } = render(
      <ScenarioShareSection
        scenario={createScenario({
          environmentId: "env-1",
          environmentError: { code: "ENV_ARCHIVED", message: "Archived." },
        })}
      />,
    );
    expect(screen.getByTestId("scenario-copy-tester-link")).toBeDisabled();

    rerender(
      <ScenarioShareSection
        scenario={createScenario({
          environmentId: "env-2",
          environmentError: null,
        })}
      />,
    );

    expect(screen.getByTestId("scenario-copy-tester-link")).not.toBeDisabled();
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "/user-testing/my-scenario/t",
    );
    expect(
      screen.queryByTestId("scenario-share-unrunnable"),
    ).not.toBeInTheDocument();
  });

  it("shows an Invited section when there are pending members", () => {
    const scenario = createScenario({
      members: [
        {
          _id: "m1",
          scenarioId: "cb-1",
          projectId: "ws-1",
          email: "pending@example.com",
          role: "chat",
          invitedBy: "u1",
          invitedAt: 1,
          user: null,
        },
      ],
    });

    render(<ScenarioShareSection scenario={scenario} />);

    expect(screen.getByText("Invited")).toBeInTheDocument();
    expect(screen.getByText("pending@example.com")).toBeInTheDocument();
  });

  it("disables the guest-link preset when the org ceiling is invited_only", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioShareSection
        scenario={createScenario({ maxShareMode: "invited_only" })}
        projectName="Acme"
      />,
    );

    expect(
      screen.getByText("Your organization limits sharing to invited users only."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Invited users only/i }));
    expect(
      screen.getByRole("menuitemradio", {
        name: /Anyone with the link/i,
      }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitemradio", { name: /Acme/i }),
    ).not.toHaveAttribute("data-disabled");
  });

  it("exposes a rotate-link kebab next to copy", () => {
    render(<ScenarioShareSection scenario={createScenario()} />);
    expect(screen.getByTestId("scenario-share-link-menu")).toBeInTheDocument();
  });

  it("confirms rotate and calls rotateScenarioLink with the scenario id", async () => {
    const user = userEvent.setup();
    const next = createScenario({
      link: {
        token: "rotated",
        path: "/c/rotated",
        url: "https://example.com/c/rotated",
        rotatedAt: 2,
        updatedAt: 2,
      },
    });
    scenarioMutations.rotateScenarioLink.mockResolvedValue(next);
    const onUpdated = vi.fn();

    render(
      <ScenarioShareSection
        scenario={createScenario()}
        onUpdated={onUpdated}
      />,
    );

    await user.click(screen.getByTestId("scenario-share-link-menu"));
    await user.click(screen.getByTestId("share-rotate-link"));
    expect(scenarioMutations.rotateScenarioLink).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("scenario-rotate-confirm"));
    expect(scenarioMutations.rotateScenarioLink).toHaveBeenCalledWith({
      scenarioId: "cb-1",
    });
    expect(onUpdated).toHaveBeenCalledWith(next);
    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "/user-testing/my-scenario/rotated",
    );
  });

  it("surfaces a rejected rotate mutation", async () => {
    const user = userEvent.setup();
    scenarioMutations.rotateScenarioLink.mockRejectedValue(
      new Error("rotate failed"),
    );

    render(<ScenarioShareSection scenario={createScenario()} />);

    await user.click(screen.getByTestId("scenario-share-link-menu"));
    await user.click(screen.getByTestId("share-rotate-link"));
    await user.click(screen.getByTestId("scenario-rotate-confirm"));
    expect(scenarioMutations.rotateScenarioLink).toHaveBeenCalledWith({
      scenarioId: "cb-1",
    });
    expect(toast.error).toHaveBeenCalledWith("rotate failed");
  });
});

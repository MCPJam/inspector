/**
 * Who is offered "Publish to project library", and what happens when it fails.
 *
 * The globe button was rendered for every personal skill, but the backend
 * (`projectSkills:promoteSkillToProject`) requires project admin — the same
 * `canManageProjectMembers` authority `canManageMembers` resolves. A member
 * who clicked it got a rejected request whose only trace was a `console.error`
 * line: the button looked broken rather than forbidden.
 *
 * Two fixes, both pinned here: don't offer what the server will refuse, and
 * when a promote a user IS allowed to attempt fails anyway (revoked mid-
 * session, a lost network, an owner check the client can't see), say so where
 * the person who clicked is looking.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    canManageMembers: false,
    promoteSkill: vi.fn(async () => undefined),
    toastError: vi.fn(),
  },
}));

const PERSONAL_SKILL = {
  name: "refunds",
  description: "Handle refunds",
  path: "Library",
  skillId: "skill-refunds",
  sharing: "user" as const,
  isOwner: true,
  origin: "cloud" as const,
  provenance: "authored" as const,
};

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: vi.fn(async () => [PERSONAL_SKILL]),
  getSkill: vi.fn(async () => ({
    name: "refunds",
    description: "Handle refunds",
    content: "# Refunds",
    path: "Library",
  })),
  deleteSkill: vi.fn(),
  listSkillFiles: vi.fn(async () => []),
  readSkillFile: vi.fn(async () => ({
    path: "SKILL.md",
    content: "# Refunds",
    mimeType: "text/markdown",
  })),
  promoteSkill: (...args: unknown[]) => mocks.promoteSkill(...args),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, HOSTED_MODE: true };
});

vi.mock("../skills/ServerSkillsSection", () => ({
  ServerSkillsSection: () => <div data-testid="server-skills" />,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    canManageMembers: mocks.canManageMembers,
    isLoading: false,
  }),
}));

import { SkillsTab } from "../SkillsTab";

/** Render the tab and open the one personal skill it lists. */
async function openTheSkill() {
  render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);
  fireEvent.click(await screen.findByText("refunds"));
  // The header renders once the detail load lands.
  await screen.findByText("Personal");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManageMembers = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsTab — publishing a personal skill to the library", () => {
  it("withholds the button from a member who cannot publish", async () => {
    await openTheSkill();

    expect(
      screen.queryByRole("button", { name: /publish to project library/i }),
    ).not.toBeInTheDocument();
  });

  it("offers it to an admin", async () => {
    mocks.canManageMembers = true;
    await openTheSkill();

    expect(
      await screen.findByRole("button", {
        name: /publish to project library/i,
      }),
    ).toBeInTheDocument();
  });

  it("surfaces a rejected publish to the person who clicked", async () => {
    mocks.canManageMembers = true;
    mocks.promoteSkill.mockRejectedValueOnce(
      new Error("Only project admins can publish a skill"),
    );
    await openTheSkill();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /publish to project library/i,
      }),
    );

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.toastError.mock.calls[0][0]).toContain("refunds");
    expect(mocks.toastError.mock.calls[0][0]).toContain(
      "Only project admins can publish a skill",
    );
  });

  it("says nothing when the publish succeeds", async () => {
    mocks.canManageMembers = true;
    await openTheSkill();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /publish to project library/i,
      }),
    );

    await waitFor(() => expect(mocks.promoteSkill).toHaveBeenCalled());
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

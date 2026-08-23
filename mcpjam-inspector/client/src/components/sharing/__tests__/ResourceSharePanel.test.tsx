import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareSettingsEnvelope } from "../share-types";
import { ResourceSharePanel } from "../ResourceSharePanel";

const settingsState = vi.hoisted(() => ({
  settings: null as ShareSettingsEnvelope | null,
  isLoading: false,
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

vi.mock("@/hooks/useShares", () => ({
  useShareSettings: () => settingsState,
  useShareMutations: () => ({
    setShareMode: vi.fn(),
    rotateShareLink: vi.fn(),
    upsertShareMember: vi.fn(),
    removeShareMember: vi.fn(),
    revokeAllShares: vi.fn(),
  }),
}));

function envelope(
  overrides: Partial<ShareSettingsEnvelope> = {},
): ShareSettingsEnvelope {
  return {
    resourceType: "evalRun",
    resourceId: "run-1",
    mode: "invited_only",
    policyVersion: 1,
    link: { token: "tok" },
    members: [],
    ...overrides,
  };
}

describe("ResourceSharePanel", () => {
  beforeEach(() => {
    settingsState.settings = envelope({ maxShareMode: "invited_only" });
    settingsState.isLoading = false;
  });

  it("derives disabled presets from envelope.maxShareMode", async () => {
    const user = userEvent.setup();
    render(
      <ResourceSharePanel
        resourceType="evalRun"
        resourceId="run-1"
        linkLabel="Share link"
        buildShareUrl={(token) => `https://example.com/s/${token}`}
        testIdPrefix="eval-share"
      />,
    );

    expect(
      screen.getByText("Your organization limits sharing to invited users only."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Invited users only/i }));
    expect(
      screen.getByRole("menuitemradio", { name: /Anyone with the link/i }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitemradio", { name: /Project members/i }),
    ).not.toHaveAttribute("data-disabled");
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShareSection, type ShareSectionProps } from "../ShareSection";
import type { ShareMemberView, ShareSettingsEnvelope } from "../share-types";

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/toast", () => ({ toast }));

function envelope(
  overrides: Partial<ShareSettingsEnvelope> = {},
): ShareSettingsEnvelope {
  return {
    resourceType: "scenario",
    resourceId: "r1",
    mode: "invited_only",
    policyVersion: 1,
    link: { token: "tok" },
    members: [],
    ...overrides,
  };
}

const presets = [
  { value: "invited_only", label: "Invited users only", description: "Invitees" },
  {
    value: "link_guests",
    label: "Anyone with the link",
    description: "Open link",
  },
  { value: "project", label: "Acme", description: "Project members" },
] as const;

function renderShare(
  overrides: Partial<ShareSectionProps<ShareSettingsEnvelope>> = {},
) {
  const props: ShareSectionProps<ShareSettingsEnvelope> = {
    envelope: envelope(),
    isAuthenticated: true,
    displayName: "Test User",
    displayEmail: "test@example.com",
    selfEmailLower: "test@example.com",
    members: [],
    shareUrl: "https://example.com/s/tok",
    displayLink: "example.com/s/tok",
    currentPreset: "invited_only",
    presets,
    onSetPreset: vi.fn(),
    onInvite: vi.fn(),
    onRemoveMember: vi.fn(),
    copy: { linkLabel: "Share link" },
    testIds: { copy: "share-copy", linkOutput: "share-link", email: "share-email" },
    ...overrides,
  };
  return render(<ShareSection {...props} />);
}

describe("ShareSection", () => {
  it("replaces the envelope after a mutation and does not copy on mode change", async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();
    const onSetPreset = vi.fn(async () =>
      envelope({ mode: "anyone_with_link", policyVersion: 2 }),
    );
    const { copyToClipboard } = await import("@/lib/clipboard");

    render(
      <ShareSection
        envelope={envelope()}
        onUpdated={onUpdated}
        isAuthenticated
        displayName="Test User"
        displayEmail="test@example.com"
        selfEmailLower="test@example.com"
        members={[]}
        shareUrl="https://example.com/user-testing/x/tok"
        displayLink="example.com/user-testing/x/tok"
        currentPreset="invited_only"
        presets={presets}
        onSetPreset={onSetPreset}
        onInvite={vi.fn()}
        onRemoveMember={vi.fn()}
        copy={{ linkLabel: "Share link" }}
        testIds={{ copy: "share-copy", linkOutput: "share-link" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Invited users only/i }));
    await user.click(screen.getByText("Anyone with the link"));
    expect(onSetPreset).toHaveBeenCalledWith("link_guests");
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ policyVersion: 2 }),
    );
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("disables copy and invite when disabledReason is set", () => {
    render(
      <ShareSection
        envelope={envelope()}
        isAuthenticated
        displayName="Test User"
        selfEmailLower="test@example.com"
        members={[]}
        shareUrl={null}
        displayLink={null}
        currentPreset="invited_only"
        presets={presets}
        onSetPreset={vi.fn()}
        onInvite={vi.fn()}
        onRemoveMember={vi.fn()}
        disabledReason="This scenario's environment was archived."
        copy={{
          linkLabel: "Tester link",
          withheldLabel: "Withheld — this scenario can't run.",
        }}
        testIds={{
          copy: "scenario-copy-tester-link",
          unrunnable: "scenario-share-unrunnable",
          linkOutput: "scenario-tester-link",
        }}
      />,
    );

    expect(screen.getByLabelText("Tester link")).toHaveTextContent(
      "Withheld — this scenario can't run.",
    );
    expect(screen.getByTestId("scenario-copy-tester-link")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
    expect(screen.getByTestId("scenario-share-unrunnable")).toHaveTextContent(
      "This scenario's environment was archived.",
    );
  });

  it("copy does not mutate; rotate asks for confirm then calls rotate", async () => {
    const user = userEvent.setup();
    const onRotateLink = vi.fn(async () =>
      envelope({ link: { token: "new" }, policyVersion: 3 }),
    );
    const onUpdated = vi.fn();
    const { copyToClipboard } = await import("@/lib/clipboard");

    render(
      <ShareSection
        envelope={envelope()}
        onUpdated={onUpdated}
        isAuthenticated
        displayName="Test User"
        selfEmailLower="test@example.com"
        members={[]}
        shareUrl="https://example.com/s/tok"
        displayLink="example.com/s/tok"
        currentPreset="invited_only"
        presets={presets}
        onSetPreset={vi.fn()}
        onInvite={vi.fn()}
        onRemoveMember={vi.fn()}
        onRotateLink={onRotateLink}
        copy={{ linkLabel: "Share link" }}
        testIds={{
          copy: "share-copy",
          rotate: "share-rotate-menu",
          rotateConfirm: "share-rotate-confirm",
          linkOutput: "share-link",
        }}
      />,
    );

    await user.click(screen.getByTestId("share-copy"));
    expect(copyToClipboard).toHaveBeenCalledWith("https://example.com/s/tok");
    expect(onRotateLink).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("share-rotate-menu"));
    await user.click(screen.getByTestId("share-rotate-link"));
    expect(onRotateLink).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("share-rotate-confirm"));
    expect(onRotateLink).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ policyVersion: 3 }),
    );
  });

  it("does not copy a stale URL when sharing is disabled", async () => {
    const user = userEvent.setup();
    const { copyToClipboard } = await import("@/lib/clipboard");

    renderShare({
      disabledReason: "This scenario's environment was archived.",
      copy: {
        linkLabel: "Share link",
        withheldLabel: "Withheld — this scenario can't run.",
      },
    });

    expect(screen.getByLabelText("Share link")).toHaveTextContent(
      "Withheld — this scenario can't run.",
    );
    expect(screen.getByTestId("share-copy")).toBeDisabled();
    await user.click(screen.getByTestId("share-copy"));
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("rejects invalid invite emails before calling onInvite", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn();

    renderShare({ onInvite });

    await user.type(screen.getByPlaceholderText("Add people, emails..."), "not-an-email");
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite", exact: true })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Invite", exact: true }));
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("surfaces invite mutation rejection", async () => {
    const user = userEvent.setup();
    const onInvite = vi.fn(async () => {
      throw new Error("invite denied");
    });

    renderShare({ onInvite });

    await user.type(screen.getByPlaceholderText("Add people, emails..."), "a@b.com");
    await user.click(screen.getByRole("button", { name: "Invite", exact: true }));
    expect(onInvite).toHaveBeenCalledWith("a@b.com");
    expect(toast.error).toHaveBeenCalledWith("invite denied");
  });

  it("removes an accepted member", async () => {
    const user = userEvent.setup();
    const member: ShareMemberView = {
      id: "m1",
      email: "member@example.com",
      userId: "u-2",
      user: { name: "Member" },
    };
    const onRemoveMember = vi.fn(async () => envelope());
    const onUpdated = vi.fn();

    renderShare({ members: [member], onRemoveMember, onUpdated });

    await user.click(screen.getByRole("button", { name: /Member/i }));
    await user.click(screen.getByText("Remove access"));
    expect(onRemoveMember).toHaveBeenCalledWith(member);
    expect(onUpdated).toHaveBeenCalled();
  });

  it("greys over-ceiling presets and does not call onSetPreset", async () => {
    const user = userEvent.setup();
    const onSetPreset = vi.fn();
    const ceilingPresets = [
      {
        value: "invited_only",
        label: "Invited users only",
        description: "Invitees",
      },
      {
        value: "link_guests",
        label: "Anyone with the link",
        description: "Open link",
        disabled: true,
        disabledReason: "Your organization limits sharing to invited users only.",
      },
      { value: "project", label: "Acme", description: "Project members" },
    ];

    renderShare({ presets: ceilingPresets, onSetPreset });

    expect(
      screen.getByText("Your organization limits sharing to invited users only."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Invited users only/i }));
    const linkOption = screen.getByRole("menuitemradio", {
      name: /Anyone with the link/i,
    });
    expect(linkOption).toHaveAttribute("data-disabled");
    await user.click(linkOption);
    expect(onSetPreset).not.toHaveBeenCalled();
  });

  it("exposes revoke-all without requiring rotate", async () => {
    const user = userEvent.setup();
    const onRevokeAll = vi.fn(async () =>
      envelope({ policyVersion: 4, members: [] }),
    );
    const onUpdated = vi.fn();

    renderShare({ onRevokeAll, onUpdated });

    expect(screen.queryByTestId("share-rotate-link")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("share-rotate-menu"));
    await user.click(screen.getByTestId("share-revoke-all"));
    expect(onRevokeAll).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ policyVersion: 4 }),
    );
  });
});

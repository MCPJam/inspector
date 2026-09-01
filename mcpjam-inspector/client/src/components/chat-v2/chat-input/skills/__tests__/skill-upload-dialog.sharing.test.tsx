/**
 * Where an uploaded skill lands, and who decides.
 *
 * The dialog used to ask: a "Share with the project" checkbox, unchecked by
 * default, whose small print admitted that ticking it "requires admin". A
 * non-admin who ticked it committed the whole upload before the backend
 * refused it, and an admin — the one person for whom the project library is
 * the obvious destination — had to opt in every time.
 *
 * So the tier is RESOLVED, not asked: `canManageMembers` is the same backend
 * authority (`canManageProjectMembers`) that gates `createSkill`'s
 * `sharing: 'project'`, and it fails closed. The dialog states the outcome
 * instead of offering a decision the user may not be allowed to make.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    canManageMembers: false,
    roleLoading: false,
    authLoading: false,
    uploadSkillFolder: vi.fn(async () => ({
      name: "refunds",
      description: "Handle refunds",
      content: "",
      path: "Library",
    })),
  },
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  uploadSkillFolder: (...args: unknown[]) => mocks.uploadSkillFolder(...args),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: !mocks.authLoading,
    isLoading: mocks.authLoading,
  }),
}));

const useProjectMembers = vi.fn(() => ({
  canManageMembers: mocks.canManageMembers,
  isLoading: mocks.roleLoading,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: (...args: unknown[]) => useProjectMembers(...args),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SkillUploadDialog } from "../skill-upload-dialog";

const CLOUD = { kind: "cloud" as const, projectId: "proj-1" };

/** A one-file skill folder the dialog will accept. */
const SKILL_MD = "---\nname: refunds\ndescription: Handle refunds\n---\n\nBody";

function skillFolder(): File[] {
  const file = new File([SKILL_MD], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: "refunds/SKILL.md",
  });
  // jsdom's Blob has no `text()`; the dialog reads the frontmatter with it.
  Object.defineProperty(file, "text", { value: async () => SKILL_MD });
  return [file];
}

/** Pick a folder through the file input and wait for the parse to land. */
async function pickSkillFolder() {
  // Queried off the document: Radix portals the dialog outside `container`.
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: skillFolder() });
  fireEvent.change(input);
  // The description renders twice: the folder card and the parsed-skill panel.
  await screen.findAllByText("Handle refunds");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManageMembers = false;
  mocks.roleLoading = false;
  mocks.authLoading = false;
});

describe("SkillUploadDialog — which tier an upload lands in", () => {
  it("sends an admin's upload to the project library", async () => {
    mocks.canManageMembers = true;
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(
      screen.getByText(/will be added to the project library/i),
    ).toBeInTheDocument();
    // No decision is offered — the checkbox is gone, not merely disabled.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /add to library/i }));

    await waitFor(() => expect(mocks.uploadSkillFolder).toHaveBeenCalled());
    expect(mocks.uploadSkillFolder.mock.calls[0][3]).toBe("project");
  });

  it("lands a non-admin's upload as personal, and says an admin can publish it", async () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(
      screen.getByText(/added as a personal skill/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/admin can publish it to the project library/i),
    ).toBeInTheDocument();

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /add to library/i }));

    await waitFor(() => expect(mocks.uploadSkillFolder).toHaveBeenCalled());
    expect(mocks.uploadSkillFolder.mock.calls[0][3]).toBe("user");
  });

  it("keeps local uploads out of the tier question entirely", async () => {
    // A local skill is a file on this machine — it has no sharing tier to
    // resolve and no library hint to show, whatever the member's role is.
    mocks.canManageMembers = true;
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    expect(
      screen.queryByText(/project library/i),
    ).not.toBeInTheDocument();

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /upload skill/i }));

    await waitFor(() => expect(mocks.uploadSkillFolder).toHaveBeenCalled());
    expect(mocks.uploadSkillFolder.mock.calls[0][3]).toBe("user");
  });

  it("holds the members query closed until the dialog is open on a project", () => {
    // The dialog is mounted (closed) by every chat input, so an ungated query
    // would hold a standing Convex subscription per composer on screen.
    render(
      <SkillUploadDialog open={false} onOpenChange={vi.fn()} source={CLOUD} />,
    );

    expect(useProjectMembers).toHaveBeenCalledWith(
      expect.objectContaining({ isAuthenticated: false }),
    );
  });

  it("holds the upload while the role is still resolving", async () => {
    // Failing closed is not good enough here. An admin who drops a folder and
    // submits inside this window would silently land a PERSONAL skill, which
    // contradicts the rule the dialog itself states two lines above the button.
    mocks.roleLoading = true;
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(screen.getByText(/Checking your role in this project/i))
      .toBeInTheDocument();

    await pickSkillFolder();
    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).toBeDisabled();
    expect(mocks.uploadSkillFolder).not.toHaveBeenCalled();
  });

  it("keeps a resolved role through a reconnect instead of re-asking", async () => {
    // Convex throws its whole remote query set away on every websocket
    // reconnect, so `useQuery` goes back to `undefined`. Without a latch, a
    // reconnect while the dialog is open — role long since resolved, files
    // already picked — would re-disable the button and flip the hint back to
    // "Checking your role…", freezing a submit over an answered question.
    mocks.canManageMembers = true;
    const { rerender } = render(
      <SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />,
    );
    await pickSkillFolder();
    expect(
      screen.getByText(/will be added to the project library/i),
    ).toBeInTheDocument();

    // The socket drops: the query replays "not decided yet".
    mocks.roleLoading = true;
    rerender(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByText(/will be added to the project library/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add to library/i }));
    await waitFor(() => expect(mocks.uploadSkillFolder).toHaveBeenCalled());
    expect(mocks.uploadSkillFolder.mock.calls[0][3]).toBe("project");
  });

  it("re-asks on reopen instead of answering with the last session's role", async () => {
    // A reconnect is a re-load of a question already asked; a REOPEN is a new
    // question. An admin demoted between two opens would otherwise reopen to
    // an enabled button and upload `sharing: 'project'` before the new query
    // landed, and the server would refuse it.
    mocks.canManageMembers = true;
    const { rerender } = render(
      <SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />,
    );
    expect(
      screen.getByText(/will be added to the project library/i),
    ).toBeInTheDocument();

    rerender(
      <SkillUploadDialog open={false} onOpenChange={vi.fn()} source={CLOUD} />,
    );

    // Reopened while the fresh role query is still in flight.
    mocks.canManageMembers = false;
    mocks.roleLoading = true;
    rerender(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(
      screen.getByText(/Checking your role in this project/i),
    ).toBeInTheDocument();
    await pickSkillFolder();
    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).toBeDisabled();
    expect(mocks.uploadSkillFolder).not.toHaveBeenCalled();
  });

  it("refuses to reuse a 'decision' taken while the dialog was closed", async () => {
    // The query is SKIPPED when the dialog is closed, so `canManageMembers`
    // reads false and `isLoading` reads false — a non-answer that looks
    // settled. Latching it would restore the very bug the guard closes.
    mocks.canManageMembers = false;
    const { rerender } = render(
      <SkillUploadDialog open={false} onOpenChange={vi.fn()} source={CLOUD} />,
    );

    mocks.roleLoading = true;
    rerender(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(
      screen.getByText(/Checking your role in this project/i),
    ).toBeInTheDocument();
  });

  it("holds the upload while Convex auth is still hydrating", async () => {
    // The trap one layer up: while auth hydrates, `isAuthenticated` reads
    // FALSE, so the members query is never enabled and `roleLoading` is false
    // too. The role then looks settled at "not an admin" though nothing was
    // asked — exactly the bug the resolving guard exists to close.
    mocks.authLoading = true;
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    expect(screen.getByText(/Checking your role in this project/i))
      .toBeInTheDocument();

    await pickSkillFolder();
    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).toBeDisabled();
    expect(mocks.uploadSkillFolder).not.toHaveBeenCalled();
  });

  it("never holds a local upload on a question that was never asked", async () => {
    // The members query is not enabled in local mode, so `isLoading` is false
    // there — but a future hook that reported otherwise must not freeze a
    // filesystem upload that has no tier to resolve.
    mocks.roleLoading = true;
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /upload skill/i }));

    await waitFor(() => expect(mocks.uploadSkillFolder).toHaveBeenCalled());
    expect(mocks.uploadSkillFolder.mock.calls[0][3]).toBe("user");
  });

  it("refuses a folder with no SKILL.md, and uploads nothing", async () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const stray = new File(["nope"], "README.md", { type: "text/markdown" });
    Object.defineProperty(stray, "text", { value: async () => "nope" });
    Object.defineProperty(input, "files", { value: [stray] });
    fireEvent.change(input);

    expect(
      await screen.findByText(/No SKILL.md file found/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).toBeDisabled();
    expect(mocks.uploadSkillFolder).not.toHaveBeenCalled();
  });

  it("refuses a SKILL.md whose name the backend would reject", async () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    const body = "---\nname: Not A Valid Name\ndescription: d\n---\n";
    const file = new File([body], "SKILL.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => body });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    expect(await screen.findByText(/Invalid skill name/i)).toBeInTheDocument();
    expect(mocks.uploadSkillFolder).not.toHaveBeenCalled();
  });

  it("shows the server's message when the upload itself is rejected", async () => {
    mocks.canManageMembers = true;
    mocks.uploadSkillFolder.mockRejectedValueOnce(
      new Error("A skill named refunds already exists"),
    );
    render(<SkillUploadDialog open onOpenChange={vi.fn()} source={CLOUD} />);

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /add to library/i }));

    expect(
      await screen.findByText(/A skill named refunds already exists/i),
    ).toBeInTheDocument();
    // The dialog stays open so the failure is reachable, not dismissed.
    expect(
      screen.getByRole("button", { name: /add to library/i }),
    ).toBeInTheDocument();
  });

  it("stamps the created skill with the store it was written to", async () => {
    // `SkillResultCard` falls back to the composer's ambient source for an
    // unstamped result, and that source follows the ACTIVE project. Without
    // this stamp, a skill uploaded into project A and expanded after switching
    // to B would have its supporting files read out of B.
    mocks.canManageMembers = true;
    const onSkillCreated = vi.fn();
    render(
      <SkillUploadDialog
        open
        onOpenChange={vi.fn()}
        source={CLOUD}
        onSkillCreated={onSkillCreated}
      />,
    );

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /add to library/i }));

    await waitFor(() => expect(onSkillCreated).toHaveBeenCalled());
    expect(onSkillCreated.mock.calls[0][0].source).toEqual(CLOUD);
  });

  it("leaves a local upload unstamped rather than inventing a source", async () => {
    // There is no source to record for a filesystem write, and stamping a
    // fabricated one would be worse than the existing fallback.
    const onSkillCreated = vi.fn();
    render(
      <SkillUploadDialog
        open
        onOpenChange={vi.fn()}
        onSkillCreated={onSkillCreated}
      />,
    );

    await pickSkillFolder();
    fireEvent.click(screen.getByRole("button", { name: /upload skill/i }));

    await waitFor(() => expect(onSkillCreated).toHaveBeenCalled());
    expect(onSkillCreated.mock.calls[0][0].source).toBeUndefined();
  });

  it("asks nothing of Convex for a local upload", () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    expect(useProjectMembers).toHaveBeenCalledWith({
      isAuthenticated: false,
      projectId: null,
    });
  });
});

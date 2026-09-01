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
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

const useProjectMembers = vi.fn(() => ({
  canManageMembers: mocks.canManageMembers,
  isLoading: false,
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

  it("asks nothing of Convex for a local upload", () => {
    render(<SkillUploadDialog open onOpenChange={vi.fn()} />);

    expect(useProjectMembers).toHaveBeenCalledWith({
      isAuthenticated: false,
      projectId: null,
    });
  });
});

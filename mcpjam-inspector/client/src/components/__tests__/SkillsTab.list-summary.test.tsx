/**
 * The header count and the "no skills yet" call to action describe the LIST.
 *
 * They used to describe the project store alone, which was unambiguous while
 * server skills sat under a heading of their own. Once the headings went and
 * both halves became one flat list, each claim became visibly wrong in the same
 * screenshot: a badge reading "Skills 0" above server rows, and a centred
 * upload prompt reserving a block of vertical space between the header and
 * those same rows.
 */
import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listSkills, serverListing } = vi.hoisted(() => ({
  listSkills: vi.fn(async () => [] as Array<{ name: string }>),
  serverListing: { count: 0, pending: false },
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills,
  getSkill: vi.fn(async () => null),
  deleteSkill: vi.fn(),
  listSkillFiles: vi.fn(async () => []),
  readSkillFile: vi.fn(async () => null),
  promoteSkill: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, HOSTED_MODE: true };
});

// Stands in for the real per-connection fetch: it answers with whatever this
// test's `serverListing` says, on the same channel the real section uses.
vi.mock("../skills/ServerSkillsSection", () => ({
  ServerSkillsSection: ({
    onListingChange,
  }: {
    onListingChange?: (state: { count: number; pending: boolean }) => void;
  }) => {
    useEffect(() => {
      onListingChange?.(serverListing);
    }, [onListingChange]);
    return <div data-testid="server-skills" />;
  },
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// The tab resolves the publish permission from Convex; these suites are about
// the tab's chrome, not about that resolution (see SkillsTab.promote-gate).
vi.mock("convex/react", () => ({ useConvexAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: false, isLoading: false }),
}));

import { SkillsTab } from "../SkillsTab";

beforeEach(() => {
  listSkills.mockClear();
  listSkills.mockResolvedValue([]);
  serverListing.count = 0;
  serverListing.pending = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsTab — what the header and the placeholder claim", () => {
  it("counts both halves of the list", async () => {
    listSkills.mockResolvedValue([{ name: "refunds" }]);
    serverListing.count = 2;

    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    // Not "1": the badge sits next to a list, and is read as its length.
    expect(await screen.findByText("3")).toBeInTheDocument();
  });

  it("does not reserve space for an upload prompt above server rows", async () => {
    serverListing.count = 2;

    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.queryByText("No skills available")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add your first skill/i })
    ).not.toBeInTheDocument();
    expect(await screen.findByText("2")).toBeInTheDocument();
  });

  it("still offers the upload prompt when the whole list is empty", async () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    expect(
      await screen.findByRole("button", { name: /add your first skill/i })
    ).toBeInTheDocument();
  });

  it("withholds the upload prompt while a server listing is outstanding", async () => {
    serverListing.pending = true;

    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    // An unanswered listing is not an empty one — offering to upload here would
    // flash away the moment the rows land.
    expect(
      screen.queryByRole("button", { name: /add your first skill/i })
    ).not.toBeInTheDocument();
  });
});

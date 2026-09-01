/**
 * The `/` picker shows BOTH halves of the project catalog, badged.
 *
 * It used to show one or the other, decided by build mode: hosted read the
 * project library, local read the filesystem. So a local user's own project
 * skills — the durable, versioned ones the library exists for — were
 * unreachable from the place skills are actually used, and a hosted user's
 * picker silently omitted a half that simply doesn't exist there.
 *
 * Merging them raises the question the old design never had to answer: two
 * skills may share a name. They are different artifacts, so both rows render,
 * each badged, and each carries its OWN source — which is what `getSkill`
 * reads through and what gets stamped onto the selection. A row that read
 * through the ambient source would return the other half's content.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListSkills, mockGetSkill, mockTrack } = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockGetSkill: vi.fn(),
  mockTrack: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));

vi.mock("@/lib/apis/server-skills-api", () => ({
  listServerSkills: vi.fn(async () => ({ skills: [] })),
  getServerSkill: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

import { SkillsPopoverSection } from "../skills-popover-section";

const LIBRARY = { kind: "cloud" as const, projectId: "proj-1" };

const localItem = (name: string) => ({
  name,
  description: `local ${name}`,
  path: `~/.mcpjam/skills/${name}`,
  origin: "local" as const,
});
const libraryItem = (name: string) => ({
  name,
  description: `library ${name}`,
  path: "Library",
  skillId: `skill-${name}`,
  sharing: "project" as const,
  isOwner: false,
  origin: "cloud" as const,
});

/** Answer the two half-listings by the source each was called with. */
function halves({
  local = [] as unknown[],
  library = [] as unknown[],
  localFails = false,
  libraryFails = false,
} = {}) {
  mockListSkills.mockImplementation(async (source?: { kind: string }) => {
    if (source?.kind === "cloud") {
      if (libraryFails) throw new Error("convex unreachable");
      return library;
    }
    if (localFails) throw new Error("no filesystem here");
    return local;
  });
}

function renderPicker(props: Record<string, unknown> = {}) {
  return render(
    <SkillsPopoverSection
      onSkillSelected={vi.fn()}
      highlightedIndex={-1}
      setHighlightedIndex={vi.fn()}
      startIndex={0}
      isHovering={false}
      actionTrigger={null}
      skillsSource={LIBRARY}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSkill.mockImplementation(async (name: string) => ({
    name,
    description: "d",
    content: "# body",
    path: "SKILL.md",
  }));
});

afterEach(() => {
  // The failure cases silence `console.error`; leaving the spy installed would
  // swallow diagnostics in every test that ran after them.
  vi.restoreAllMocks();
});

describe("SkillsPopoverSection — local and library in one list", () => {
  it("renders both halves, each badged with the store it came from", async () => {
    halves({ local: [localItem("notes")], library: [libraryItem("refunds")] });
    renderPicker();

    expect(await screen.findByText("notes")).toBeInTheDocument();
    expect(screen.getByText("refunds")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
  });

  it("shows a name held by both halves twice, not once", async () => {
    // They are different artifacts with different contents. Collapsing them
    // would choose for the user, silently and by fetch order.
    halves({ local: [localItem("refunds")], library: [libraryItem("refunds")] });
    renderPicker();

    await waitFor(() =>
      expect(screen.getAllByText("refunds")).toHaveLength(2),
    );
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
  });

  it("reads each row through its own source and stamps it on the result", async () => {
    halves({ local: [localItem("refunds")], library: [libraryItem("refunds")] });
    const onSkillSelected = vi.fn();
    renderPicker({ onSkillSelected });

    await waitFor(() =>
      expect(screen.getAllByText("refunds")).toHaveLength(2),
    );
    // Local rows come first, so the first match is the local one.
    fireEvent.click(screen.getAllByText("refunds")[0]!);

    await waitFor(() => expect(onSkillSelected).toHaveBeenCalled());
    expect(mockGetSkill).toHaveBeenCalledWith("refunds", { kind: "local" });
    // Stamped even for a local row: the card's fallback prop now names the
    // library, so an unstamped local skill would expand against Convex.
    expect(onSkillSelected.mock.calls[0][0].source).toEqual({ kind: "local" });
  });

  it("reads a library row through the library source", async () => {
    halves({ local: [localItem("refunds")], library: [libraryItem("refunds")] });
    const onSkillSelected = vi.fn();
    renderPicker({ onSkillSelected });

    await waitFor(() =>
      expect(screen.getAllByText("refunds")).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByText("refunds")[1]!);

    await waitFor(() => expect(onSkillSelected).toHaveBeenCalled());
    expect(mockGetSkill).toHaveBeenCalledWith("refunds", LIBRARY);
    expect(onSkillSelected.mock.calls[0][0].source).toEqual(LIBRARY);
  });

  it("records which half a selection came from", async () => {
    halves({ library: [libraryItem("refunds")] });
    renderPicker();

    fireEvent.click(await screen.findByText("refunds"));

    await waitFor(() => expect(mockTrack).toHaveBeenCalled());
    expect(mockTrack).toHaveBeenCalledWith(
      "skill_injected",
      expect.objectContaining({ skill_origin: "library" }),
    );
  });

  it("asks for no library half when there is no library to read", async () => {
    halves({ local: [localItem("notes")] });
    renderPicker({ skillsSource: undefined });

    expect(await screen.findByText("notes")).toBeInTheDocument();
    expect(screen.queryByText("Library")).not.toBeInTheDocument();
    for (const call of mockListSkills.mock.calls) {
      expect(call[0]).toBeUndefined();
    }
  });

  it("still renders one half when the other fails", async () => {
    // An unreachable Convex must not take the user's local files off the menu.
    halves({ local: [localItem("notes")], libraryFails: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPicker();

    expect(await screen.findByText("notes")).toBeInTheDocument();
    expect(screen.queryByText("refunds")).not.toBeInTheDocument();
  });

  it("still renders the library when the local half fails", async () => {
    halves({ library: [libraryItem("refunds")], localFails: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPicker();

    expect(await screen.findByText("refunds")).toBeInTheDocument();
  });

  it("renders the local half while the library half is still hanging", async () => {
    // `allSettled` on the PAIR bought independence from one half FAILING but
    // none from one half being SLOW: a Convex request that hangs rather than
    // rejects would hold ready local files behind a spinner for as long as it
    // took.
    mockListSkills.mockImplementation(async (source?: { kind: string }) => {
      if (source?.kind === "cloud") return new Promise(() => {}); // never settles
      return [localItem("notes")];
    });
    renderPicker();

    expect(await screen.findByText("notes")).toBeInTheDocument();
    expect(screen.queryByText(/Loading skills/i)).not.toBeInTheDocument();
  });

  it("renders the library half while the local half is still hanging", async () => {
    mockListSkills.mockImplementation(async (source?: { kind: string }) => {
      if (source?.kind === "cloud") return [libraryItem("refunds")];
      return new Promise(() => {});
    });
    renderPicker();

    expect(await screen.findByText("refunds")).toBeInTheDocument();
  });

  it("withholds the empty state while a half is still outstanding", async () => {
    // "No skills found" over a half that is still coming is a claim about a
    // catalog nobody has read yet.
    mockListSkills.mockImplementation(async (source?: { kind: string }) => {
      if (source?.kind === "cloud") return new Promise(() => {});
      return [];
    });
    renderPicker({ onOpenUploadDialog: vi.fn() });

    await waitFor(() =>
      expect(screen.queryByText(/Loading skills/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/No skills found/i)).not.toBeInTheDocument();
  });

  it("says so plainly when both halves come back empty", async () => {
    halves({});
    renderPicker({ onOpenUploadDialog: vi.fn() });

    expect(await screen.findByText(/No skills found/i)).toBeInTheDocument();
  });

  it("stops the row spinning when loading the chosen skill fails", async () => {
    // Otherwise the row spins forever and the picker looks hung on a click
    // that has already failed.
    halves({ library: [libraryItem("refunds")] });
    mockGetSkill.mockRejectedValueOnce(new Error("skill was deleted"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onSkillSelected = vi.fn();
    renderPicker({ onSkillSelected });

    fireEvent.click(await screen.findByText("refunds"));

    await waitFor(() =>
      expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument(),
    );
    expect(onSkillSelected).not.toHaveBeenCalled();
    // The row is still there to try again.
    expect(screen.getByText("refunds")).toBeInTheDocument();
  });

  it("counts both halves for the parent's arrow-key range", async () => {
    halves({
      local: [localItem("notes")],
      library: [libraryItem("refunds"), libraryItem("returns")],
    });
    const onCountChange = vi.fn();
    renderPicker({ onCountChange });

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(3));
  });

  it("indexes Enter into the library range, past the local rows", async () => {
    halves({ local: [localItem("notes")], library: [libraryItem("refunds")] });
    const onSkillSelected = vi.fn();
    // Index 1 is the first LIBRARY row: local rows occupy the range below it.
    renderPicker({
      onSkillSelected,
      highlightedIndex: 1,
      actionTrigger: "Enter",
    });

    await waitFor(() => expect(onSkillSelected).toHaveBeenCalled());
    expect(mockGetSkill).toHaveBeenCalledWith("refunds", LIBRARY);
  });
});

/**
 * Orphaned-selection rows for both environment pickers.
 *
 * Both surfaces persist a list of ids and render rows from a LIVE query. An id
 * the query doesn't return — hard-deleted, unshared, or moved out of the
 * project — otherwise renders no row at all: invisible, unremovable, and still
 * shipped on every save. Each picker must surface those ids as detach-only
 * rows. (The archived-but-present case was already handled; this covers the
 * genuinely-missing case.)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnvironments, mockSetSuiteEnvironments, mockListSkills } =
  vi.hoisted(() => ({
    mockEnvironments: { value: [] as unknown[] },
    mockSetSuiteEnvironments: vi.fn(),
    mockListSkills: vi.fn(),
  }));

vi.mock("convex/react", () => ({
  useMutation: () => mockSetSuiteEnvironments,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mockEnvironments.value,
}));
vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { environments: "/environments" },
}));

import { SuiteProjectEnvironmentsPicker } from "@/components/evals/suite-project-environments-picker";
import { ProjectEnvironmentSkillsPicker } from "../ProjectEnvironmentSkillsPicker";

beforeEach(() => {
  vi.clearAllMocks();
  mockSetSuiteEnvironments.mockResolvedValue(undefined);
});

describe("SuiteProjectEnvironmentsPicker — unresolvable attached ids", () => {
  it("renders a detach-only row for an attached id the query never returns", async () => {
    // "env-live" resolves; "env-gone" was hard-deleted.
    mockEnvironments.value = [
      { environmentId: "env-live", name: "Prod-like", revision: 1 },
    ];

    render(
      <SuiteProjectEnvironmentsPicker
        suiteId="suite-1"
        projectId="proj-1"
        environmentIds={["env-live", "env-gone"]}
      />
    );

    // The popover trigger is the only button rendered before it opens; its
    // label is the joined environment names, so match it positionally.
    fireEvent.click(screen.getAllByRole("button")[0]!);

    const orphanRow = await screen.findByLabelText(
      /Unavailable environment env-gone \(detach\)/i
    );
    expect(orphanRow).toBeInTheDocument();

    // Unchecking it must commit the remaining ids — i.e. it is REMOVABLE.
    fireEvent.click(orphanRow);
    await waitFor(() => {
      expect(mockSetSuiteEnvironments).toHaveBeenCalledWith({
        suiteId: "suite-1",
        environmentIds: ["env-live"],
      });
    });
  });

  it("shows no orphan rows while the query is still loading", () => {
    mockEnvironments.value = undefined as unknown as unknown[];
    render(
      <SuiteProjectEnvironmentsPicker
        suiteId="suite-1"
        projectId="proj-1"
        environmentIds={["env-a", "env-b"]}
      />
    );
    // The popover trigger is the only button rendered before it opens; its
    // label is the joined environment names, so match it positionally.
    fireEvent.click(screen.getAllByRole("button")[0]!);
    // A loading list must not flash every attached id as an orphan.
    expect(
      screen.queryByLabelText(/Unavailable environment/i)
    ).not.toBeInTheDocument();
  });
});

describe("ProjectEnvironmentSkillsPicker — unresolvable pinned ids", () => {
  it("renders a removable row for a pinned skill missing from the shared list", async () => {
    mockListSkills.mockResolvedValue([
      { skillId: "sk-live", name: "Live skill", description: "d" },
    ]);
    const onChange = vi.fn();

    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["sk-live", "sk-gone"] }}
        onChange={onChange}
      />
    );

    const orphanRow = await screen.findByLabelText(
      /Unavailable skill sk-gone \(remove\)/i
    );
    fireEvent.click(orphanRow);
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      skillIds: ["sk-live"],
    });
  });

  it("still surfaces orphaned pins when the project has NO shared skills", async () => {
    // The empty-list early return would otherwise swallow the pins entirely,
    // leaving them invisible AND unremovable while still counted + saved.
    mockListSkills.mockResolvedValue([]);
    const onChange = vi.fn();

    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["sk-gone"] }}
        onChange={onChange}
      />
    );

    const orphanRow = await screen.findByLabelText(
      /Unavailable skill sk-gone \(remove\)/i
    );
    expect(
      screen.queryByText(/No shared skills in this project yet/i)
    ).not.toBeInTheDocument();

    // Clearing the last pin emits null, never an empty array.
    fireEvent.click(orphanRow);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

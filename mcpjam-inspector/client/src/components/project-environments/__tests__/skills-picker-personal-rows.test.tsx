/**
 * Personal skills in the environment picker: shown, disabled, explained.
 *
 * The picker used to filter them out client-side (`sharing === 'project'`),
 * which made it lie by omission. Someone who had just uploaded a skill and
 * came here to pin it found no trace of it — no way to tell whether the upload
 * had failed, whether they had mis-named it, or whether it was simply not
 * eligible. The backend already answers that question on every listed row
 * (`pinnability: { ok: false, reason: 'not_shared' }`), so the row is rendered
 * and the reason is quoted.
 *
 * The eligibility rule itself is unchanged and still enforced server-side:
 * only library skills can run in an environment, because an environment a
 * teammate runs must resolve to the same skills for them as for you.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListSkills, mockListSkillVersions } = vi.hoisted(() => ({
  mockListSkills: vi.fn(),
  mockListSkillVersions: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  listSkillVersions: (...args: unknown[]) => mockListSkillVersions(...args),
}));

import { ProjectEnvironmentSkillsPicker } from "../ProjectEnvironmentSkillsPicker";

const LIBRARY_SKILL = {
  name: "refunds",
  description: "Handle refunds",
  path: "Library",
  skillId: "skill-refunds",
  sharing: "project" as const,
  isOwner: false,
  origin: "cloud" as const,
  pinnability: { ok: true as const },
  currentVersionId: "ver-4",
  currentVersionNumber: 4,
};

const PERSONAL_SKILL = {
  name: "scratchpad",
  description: "My notes",
  path: "Library",
  skillId: "skill-scratchpad",
  sharing: "user" as const,
  isOwner: true,
  origin: "cloud" as const,
  pinnability: { ok: false as const, reason: "not_shared" },
  currentVersionId: "ver-1",
  currentVersionNumber: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListSkillVersions.mockResolvedValue([]);
  // Deliberately personal-first, so a passing sort assertion means the picker
  // sorted rather than that the fixture happened to be ordered.
  mockListSkills.mockResolvedValue([PERSONAL_SKILL, LIBRARY_SKILL]);
});

describe("ProjectEnvironmentSkillsPicker — personal skills", () => {
  it("lists a personal skill instead of hiding it", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("scratchpad")).toBeInTheDocument();
  });

  it("disables it and says why, in words rather than in an enum", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("scratchpad")).toBeDisabled();
    fireEvent.focus(screen.getByLabelText("scratchpad"));
    // Radix mirrors tooltip content into an aria-live node, so this matches
    // more than once.
    expect(
      (await screen.findAllByText(/only skills in the project library can run/i))
        .length,
    ).toBeGreaterThan(0);
    // The backend's identifier must never reach the reader.
    expect(screen.queryByText("not_shared")).not.toBeInTheDocument();
  });

  it("refuses to select it, so the save can't be built to fail", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
      />,
    );

    fireEvent.click(await screen.findByLabelText("scratchpad"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sorts library skills above the rows nobody can pick", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await screen.findByLabelText("refunds");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).toHaveAttribute("aria-label", "refunds");
    expect(boxes[1]).toHaveAttribute("aria-label", "scratchpad");
  });

  it("leaves the footer count to the selection, not to the row count", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-refunds"] }}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/1\/20 skills selected/)).toBeInTheDocument();
  });

  it("brings a pinned-then-unshared skill back as a removable row", async () => {
    // It used to vanish into the anonymous "Unavailable skill <id>" orphan row
    // — technically removable, but with no name and no explanation. Now it is
    // the skill itself, checked, ineligible, and uncheckable-to-repair.
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-scratchpad"] }}
        onChange={onChange}
      />,
    );

    const row = await screen.findByLabelText("scratchpad");
    expect(row).toBeChecked();
    // Ineligibility blocks NEW selections only, so this one can be undone.
    expect(row).not.toBeDisabled();
    expect(
      screen.queryByLabelText(/Unavailable skill/i),
    ).not.toBeInTheDocument();

    fireEvent.click(row);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("shows the empty state only when the project has no skills at all", async () => {
    mockListSkills.mockResolvedValue([]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/No skills in the project library yet/i),
    ).toBeInTheDocument();
  });

  it("does not show the empty state for a project with only personal skills", async () => {
    mockListSkills.mockResolvedValue([PERSONAL_SKILL]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await screen.findByLabelText("scratchpad");
    expect(
      screen.queryByText(/No skills in the project library yet/i),
    ).not.toBeInTheDocument();
  });
});

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

  it("disables it and says why on the row, in words rather than in an enum", async () => {
    // The reason used to live only in a tooltip whose trigger wrapped a row
    // with nothing focusable in it (the checkbox is disabled), so a keyboard
    // or screen-reader user met a greyed-out row with no stated cause. It is
    // rendered on the row now, so no hover is needed to read it.
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("scratchpad")).toBeDisabled();
    expect(
      screen.getByText(/only skills in the project library can run/i),
    ).toBeInTheDocument();
    // The backend's identifier must never reach the reader.
    expect(screen.queryByText("not_shared")).not.toBeInTheDocument();
  });

  it("shows the reason in place of the description, not beside it", async () => {
    // A reader scanning a disabled row wants the restriction, not the blurb.
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    await screen.findByLabelText("scratchpad");
    expect(screen.queryByText("My notes")).not.toBeInTheDocument();
    // An eligible row still shows its description.
    expect(screen.getByText("Handle refunds")).toBeInTheDocument();
  });

  it("falls back to a generic line for a reason it doesn't know", async () => {
    // The backend's reason list grows; an older client must say something true
    // rather than leak an identifier it has no copy for.
    mockListSkills.mockResolvedValue([
      {
        ...LIBRARY_SKILL,
        pinnability: { ok: false as const, reason: "some_future_reason" },
      },
    ]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("refunds")).toBeDisabled();
    expect(
      screen.getByText(/can't be pinned to an environment/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("some_future_reason")).not.toBeInTheDocument();
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

  it("disables a personal skill on a backend that sends no pinnability", async () => {
    // `pinnability` is optional on the wire. Consulting it alone was harmless
    // while personal rows were filtered out; now they are listed, so a row
    // with no metadata would render selectable and the SAVE would be the first
    // the user heard of the restriction. Sharing is not optional.
    const { pinnability: _dropped, ...noMetadata } = PERSONAL_SKILL;
    mockListSkills.mockResolvedValue([noMetadata]);
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
      />,
    );

    expect(await screen.findByLabelText("scratchpad")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("scratchpad"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still trusts the backend's verdict over its own where both exist", async () => {
    // The backend knows about restrictions this client cannot see (plugin
    // components), so a library skill it rejects stays rejected here.
    mockListSkills.mockResolvedValue([
      {
        ...LIBRARY_SKILL,
        pinnability: { ok: false as const, reason: "plugin_component" },
      },
    ]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("refunds")).toBeDisabled();
    expect(screen.getByText(/Delivered by its plugin/i)).toBeInTheDocument();
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

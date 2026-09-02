/**
 * The version control in the environment skills picker.
 *
 * The behaviours worth pinning here are the ones a careless refactor breaks
 * silently: Latest stays the default (an environment must not drift onto a
 * frozen revision by accident), pins ride alongside `skillIds` in the emitted
 * selection, deselecting a skill takes its pin with it, and history is fetched
 * only when someone actually opens a control.
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

const REFUNDS = {
  name: "refunds",
  description: "Handle refunds",
  path: "Library",
  skillId: "skill-refunds",
  sharing: "project" as const,
  isOwner: false,
  origin: "cloud" as const,
  currentVersionId: "ver-4",
  currentVersionNumber: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListSkills.mockResolvedValue([REFUNDS]);
  mockListSkillVersions.mockResolvedValue([
    {
      versionId: "ver-4",
      versionNumber: 4,
      versionHash: "h4",
      contentHash: "h4",
      name: "refunds",
      description: "Handle refunds",
      fileCount: 0,
      isCurrent: true,
      createdByUserId: "u1",
      createdAt: 4,
    },
    {
      versionId: "ver-1",
      versionNumber: 1,
      versionHash: "h1",
      contentHash: "h1",
      name: "refunds",
      description: "Handle refunds",
      fileCount: 0,
      isCurrent: false,
      createdByUserId: "u1",
      createdAt: 1,
    },
  ]);
});

describe("ProjectEnvironmentSkillsPicker — version pins", () => {
  it("shows Latest by default and does not fetch history until opened", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-refunds"] }}
        onChange={vi.fn()}
      />,
    );

    const control = await screen.findByLabelText("Version for skill-refunds");
    expect(control).toHaveValue("");
    expect(screen.getByText("Latest (v4)")).toBeInTheDocument();
    // A picker of 20 skills must not fire 20 history requests nobody asked for.
    expect(mockListSkillVersions).not.toHaveBeenCalled();

    fireEvent.focus(control);
    await waitFor(() => expect(mockListSkillVersions).toHaveBeenCalledTimes(1));
  });

  it("emits a versionPins entry when an exact revision is chosen", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-refunds"] }}
        onChange={onChange}
      />,
    );

    const control = await screen.findByLabelText("Version for skill-refunds");
    fireEvent.focus(control);
    await waitFor(() => expect(mockListSkillVersions).toHaveBeenCalled());
    await screen.findByText("v1");

    fireEvent.change(control, { target: { value: "ver-1" } });
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      skillIds: ["skill-refunds"],
      versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
    });
  });

  it("omits versionPins entirely when going back to Latest", async () => {
    // Absent, not `[]` — an unpinned environment must serialize (and
    // fingerprint) exactly as one written before pins existed.
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{
          mode: "explicit",
          skillIds: ["skill-refunds"],
          versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
        }}
        onChange={onChange}
      />,
    );

    const control = await screen.findByLabelText("Version for skill-refunds");
    fireEvent.change(control, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      skillIds: ["skill-refunds"],
    });
  });

  it("drops a skill's pin when the skill is deselected", async () => {
    // A pin for an unselected skill is rejected by the backend, and would be an
    // invisible passenger on every save even if it weren't.
    const onChange = vi.fn();
    mockListSkills.mockResolvedValue([
      REFUNDS,
      { ...REFUNDS, name: "tone", skillId: "skill-tone" },
    ]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{
          mode: "explicit",
          skillIds: ["skill-refunds", "skill-tone"],
          versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
        }}
        onChange={onChange}
      />,
    );

    const refundsCheckbox = await screen.findByLabelText("refunds");
    fireEvent.click(refundsCheckbox);
    expect(onChange).toHaveBeenCalledWith({
      mode: "explicit",
      skillIds: ["skill-tone"],
    });
  });

  it("stays usable when the history request fails", async () => {
    // A failed history load must not block the selection itself — the skill is
    // still selected, it just can't offer revisions to choose from.
    mockListSkillVersions.mockRejectedValue(new Error("network"));
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-refunds"] }}
        onChange={vi.fn()}
      />,
    );

    const control = await screen.findByLabelText("Version for skill-refunds");
    fireEvent.focus(control);
    await waitFor(() => expect(mockListSkillVersions).toHaveBeenCalled());
    expect(control).toHaveValue("");
    expect(screen.getByText("Latest (v4)")).toBeInTheDocument();
  });

  it("renders the empty state when the project library is empty", async () => {
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

  it("accepts a null selection without crashing", async () => {
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
      />,
    );
    // Nothing is checked, so no version control exists to show.
    expect(await screen.findByLabelText("refunds")).not.toBeChecked();
    expect(
      screen.queryByLabelText("Version for skill-refunds"),
    ).not.toBeInTheDocument();
  });

  it("disables the version control for an ineligible selected skill", async () => {
    // Its selection is rejected at save, so choosing a revision leads nowhere —
    // but the checkbox stays live so the user can remove it and repair the
    // selection.
    mockListSkills.mockResolvedValue([
      {
        ...REFUNDS,
        pinnability: { ok: false, reason: "not_shared" },
      },
    ]);
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["skill-refunds"] }}
        onChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByLabelText("Version for skill-refunds"),
    ).toBeDisabled();
    expect(screen.getByLabelText("refunds")).not.toBeDisabled();
  });

  it("keeps a pin selectable before its history has loaded", async () => {
    // Otherwise the control would render an unknown value, fall back to
    // Latest, and silently discard the pin on the next save.
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{
          mode: "explicit",
          skillIds: ["skill-refunds"],
          versionPins: [{ skillId: "skill-refunds", versionId: "ver-1" }],
        }}
        onChange={vi.fn()}
      />,
    );

    const control = await screen.findByLabelText("Version for skill-refunds");
    expect(control).toHaveValue("ver-1");
  });
});

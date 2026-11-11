/**
 * The skills picker editing several environments at once (`across`), as the
 * Evaluate page's Skills field uses it: partly-on rows, the cap checked
 * against each environment, and an explicit removal for a partly-on skill
 * that can't be turned on, since a click on its checkbox means "on".
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListSkills } = vi.hoisted(() => ({ mockListSkills: vi.fn() }));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  listSkillVersions: async () => [],
}));

import {
  ProjectEnvironmentSkillsPicker,
  type SkillSelectionAcross,
} from "../ProjectEnvironmentSkillsPicker";

const skill = (skillId: string, name: string, shared = true) => ({
  skillId,
  name,
  description: `${name} description`,
  path: "Library",
  sharing: shared ? ("project" as const) : ("user" as const),
  origin: "cloud" as const,
  pinnability: shared
    ? { ok: true as const }
    : { ok: false as const, reason: "not_shared" },
});

const across = (
  overrides: Partial<SkillSelectionAcross> = {},
): SkillSelectionAcross => ({
  partialIds: new Set(),
  largestCount: 0,
  canAdd: () => true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockListSkills.mockResolvedValue([
    skill("triage", "triage"),
    skill("notes", "my-notes", false),
  ]);
});

describe("ProjectEnvironmentSkillsPicker across environments", () => {
  it("turns a partly-on skill on with one click", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
        across={across({ partialIds: new Set(["triage"]), largestCount: 1 })}
      />,
    );
    const box = await screen.findByLabelText("triage");
    expect(box).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(
      { mode: "explicit", skillIds: ["triage"] },
      { kind: "add", skillId: "triage" },
    );
  });

  it("blocks a skill that an environment has no room for", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
        across={across({
          largestCount: 20,
          canAdd: (skillId) => skillId !== "triage",
        })}
      />,
    );
    const box = await screen.findByLabelText("triage");
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /20\/20 skills selected, the most an environment can hold/,
      ),
    ).toBeInTheDocument();
  });

  it("removes a partly-on skill that became ineligible only with its button", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={null}
        onChange={onChange}
        across={across({ partialIds: new Set(["notes"]), largestCount: 1 })}
      />,
    );
    const box = await screen.findByLabelText("my-notes");
    expect(box).toHaveAttribute("aria-checked", "mixed");
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from every client" }),
    );
    expect(onChange).toHaveBeenCalledWith(null, {
      kind: "remove",
      skillId: "notes",
    });
  });

  it("removes a partly-on skill that left the library only with its button", async () => {
    const onChange = vi.fn();
    render(
      <ProjectEnvironmentSkillsPicker
        projectId="proj-1"
        value={{ mode: "explicit", skillIds: ["triage"] }}
        onChange={onChange}
        across={across({ partialIds: new Set(["gone"]), largestCount: 2 })}
      />,
    );
    const box = await screen.findByLabelText("Unavailable skill gone (remove)");
    expect(box).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from every client" }),
    );
    expect(onChange).toHaveBeenCalledWith(
      { mode: "explicit", skillIds: ["triage"] },
      { kind: "remove", skillId: "gone" },
    );
  });
});

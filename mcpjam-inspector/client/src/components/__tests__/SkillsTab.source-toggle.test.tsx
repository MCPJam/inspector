/**
 * Which flag decides the Local⇄Cloud browse toggle.
 *
 * It used to be `computers-enabled`, a leftover from when cloud skills lived on
 * a Computer's filesystem. That stopped being true when Convex became the
 * source of truth, and the mismatch was reachable in both directions: a user
 * with Skills released but Computers not had no way to reach their own project
 * skills, and a user with the reverse got a toggle to a store they could not
 * write to.
 *
 * `HOSTED_MODE: false` throughout — hosted has no local filesystem, so there is
 * nothing to toggle between there.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: vi.fn(async () => []),
  getSkill: vi.fn(async () => null),
  deleteSkill: vi.fn(),
  listSkillFiles: vi.fn(async () => []),
  readSkillFile: vi.fn(async () => null),
  promoteSkill: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, HOSTED_MODE: false };
});

vi.mock("../skills/ServerSkillsSection", () => ({
  ServerSkillsSection: () => <div data-testid="server-skills" />,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SkillsTab } from "../SkillsTab";

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsTab — the Local/Cloud browse toggle", () => {
  it("is offered when the project store is released to this user", () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    expect(screen.getByText("Cloud")).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
  });

  it("is withheld when the project store is not released", () => {
    // Offering a switch to a store the backend will refuse to write is worse
    // than not offering it: the failure arrives after the user has committed.
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled={false} />);

    expect(screen.queryByText("Cloud")).not.toBeInTheDocument();
  });

  it("is withheld with no project to address, however the flags read", () => {
    render(<SkillsTab cloudSkillsEnabled />);

    expect(screen.queryByText("Cloud")).not.toBeInTheDocument();
  });

  it("treats an empty project id as no project, not as one named \"\"", () => {
    // The gate is `!!projectId`, so this is the boundary between "absent" and
    // "present but unusable" — and a store keyed on an empty id addresses
    // nothing the backend would accept.
    render(<SkillsTab projectId="" cloudSkillsEnabled />);

    expect(screen.queryByText("Cloud")).not.toBeInTheDocument();
  });
});

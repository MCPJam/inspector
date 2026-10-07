/**
 * Plugin skills are a source of their own in the Skills tab, counted with the
 * rest of the list, and opening one replaces the right pane with its
 * read-only detail. Outside the plugins rollout the tab shows none.
 */
import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pluginsEnabled: true,
  listSkills: vi.fn(async () => [] as Array<{ name: string }>),
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: h.listSkills,
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
vi.mock("../skills/ServerSkillsSection", () => ({
  ServerSkillsSection: () => <div data-testid="server-skills" />,
}));
vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabled: () => h.pluginsEnabled,
}));
const skill = {
  pluginId: "pl_bits",
  pluginLabel: "Bits & Bolts",
  skillId: "sk_triage",
  modelRef: "bits-and-bolts/triage",
  name: "triage",
  description: "",
};
vi.mock("../skills/PluginSkills", () => ({
  PluginSkillsSection: ({
    onOpenSkill,
    onCountChange,
  }: {
    onOpenSkill: (selected: typeof skill) => void;
    onCountChange?: (count: number) => void;
  }) => {
    useEffect(() => {
      onCountChange?.(1);
    }, [onCountChange]);
    return (
      <button type="button" onClick={() => onOpenSkill(skill)}>
        triage · Plugin · Bits & Bolts
      </button>
    );
  },
  PluginSkillDetail: ({ skill: opened }: { skill: typeof skill }) => (
    <div data-testid="plugin-skill-detail">{opened.modelRef}</div>
  ),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: false, isLoading: false }),
}));

import { SkillsTab } from "../SkillsTab";

beforeEach(() => {
  h.pluginsEnabled = true;
  h.listSkills.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsTab — plugin skills", () => {
  it("lists plugin skills, counts them, and opens one read-only", async () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    expect(await screen.findByText("1")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "triage · Plugin · Bits & Bolts" }),
    );
    expect(screen.getByTestId("plugin-skill-detail").textContent).toBe(
      "bits-and-bolts/triage",
    );
  });

  it("shows none outside the plugins rollout", async () => {
    h.pluginsEnabled = false;
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);
    expect(await screen.findByText("0")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Plugin · Bits & Bolts/ }),
    ).not.toBeInTheDocument();
  });
});

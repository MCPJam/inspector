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
  listing: { count: 1, pending: false },
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
    onListingChange,
  }: {
    onOpenSkill: (selected: typeof skill) => void;
    onListingChange?: (listing: { count: number; pending: boolean }) => void;
  }) => {
    useEffect(() => {
      onListingChange?.(h.listing);
    }, [onListingChange]);
    return (
      <button type="button" onClick={() => onOpenSkill(skill)}>
        triage · Plugin · Bits & Bolts
      </button>
    );
  },
  PluginSkillDetail: ({
    skill: opened,
    onUninstalled,
  }: {
    skill: typeof skill;
    onUninstalled?: () => void;
  }) => (
    <>
      <div data-testid="plugin-skill-detail">{opened.modelRef}</div>
      <button type="button" onClick={() => onUninstalled?.()}>
        Uninstall plugin (stub)
      </button>
    </>
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
  h.listing = { count: 1, pending: false };
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

  it("clears the opened plugin skill once its plugin is uninstalled from the detail", async () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "triage · Plugin · Bits & Bolts",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Uninstall plugin (stub)" }),
    );
    expect(screen.queryByTestId("plugin-skill-detail")).not.toBeInTheDocument();
  });

  it("does not call the list empty while plugin skills are still being listed", async () => {
    h.listing = { count: 0, pending: true };
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);
    expect(await screen.findByText("0")).toBeInTheDocument();
    expect(screen.queryByText(/No skills/i)).not.toBeInTheDocument();
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

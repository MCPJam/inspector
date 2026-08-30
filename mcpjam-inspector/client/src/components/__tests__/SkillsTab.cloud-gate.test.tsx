/**
 * `cloudSkillsEnabled` gates ONE HALF of the Skills tab.
 *
 * Cloud Skills (the project store) sit behind the `skills-enabled` rollout;
 * Skills over MCP does not, because it is a protocol capability whose routes
 * carry no product flag. So with the flag off the tab still renders and still
 * shows "From MCP servers" — it just stops offering, listing, or FETCHING the
 * project store. The last of those is the one worth pinning: the backend gates
 * authoring separately, so a list call made behind the flag is a request that
 * can only fail.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listSkills } = vi.hoisted(() => ({
  listSkills: vi.fn(async () => []),
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

// The section under test is the tab's own chrome; the server catalog fetches
// per connection and is exercised by its own suite.
vi.mock("../skills/ServerSkillsSection", () => ({
  ServerSkillsSection: () => <div data-testid="server-skills" />,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { SkillsTab } from "../SkillsTab";

beforeEach(() => {
  listSkills.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillsTab — cloud store gate", () => {
  it("hides the project store and never calls its API when disabled", () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled={false} />);

    expect(screen.getByTestId("server-skills")).toBeInTheDocument();
    expect(screen.queryByText("No skills available")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload your first skill/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload skill/i })
    ).not.toBeInTheDocument();
    // A list behind the flag is a request the backend gates anyway.
    expect(listSkills).not.toHaveBeenCalled();
  });

  it("shows the project store and lists it when enabled", async () => {
    render(<SkillsTab projectId="project-1" cloudSkillsEnabled />);

    expect(screen.getByTestId("server-skills")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /upload skill/i })
    ).toBeInTheDocument();
    expect(listSkills).toHaveBeenCalled();
  });

  it("defaults to enabled, so local mode is unaffected", () => {
    render(<SkillsTab projectId="project-1" />);
    expect(listSkills).toHaveBeenCalled();
  });
});

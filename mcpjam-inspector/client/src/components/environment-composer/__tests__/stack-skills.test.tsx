/**
 * The Skills pill over one composer stack: the MCP-server skills and the scope
 * that a saved environment's stack carries are shown, can be removed or turned
 * off, and count toward the backend's 20 with the Library picks.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectServerSkill } from "@/hooks/use-server-skills";

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  serverSkills: [] as ProjectServerSkill[],
  groups: [] as { _id: string; serverIds: string[] }[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mocks.listSkills(...args),
  listSkillVersions: async () => [],
}));
vi.mock("@/hooks/use-server-skills", () => ({
  useProjectServerSkills: () => mocks.serverSkills,
  useServerSkillVersions: () => undefined,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mocks.groups,
    isLoading: false,
  }),
}));

import {
  emptyEnvironmentStack,
  type EnvironmentStack,
} from "../environment-stack";
import { SkillsPill } from "../skills-pill";
import { stackSkillChoices } from "../stack-skills";

const library = (skillId: string) => ({
  skillId,
  name: skillId,
  description: `${skillId} description`,
  path: "Library",
  sharing: "project" as const,
  origin: "cloud" as const,
  pinnability: { ok: true as const },
  currentVersionNumber: 2,
});
const lookup: ProjectServerSkill = {
  id: "lookup",
  serverId: "crm",
  serverSlug: "acme-crm",
  ref: "acme-crm/lookup",
  name: "lookup",
  description: "lookup description",
  versionId: "lookup-v2",
  versionNumber: 2,
};
const picks = (...serverSkillIds: string[]) => ({
  mode: "explicit" as const,
  serverSkillIds,
});
const stackWith = (fields: Partial<EnvironmentStack>): EnvironmentStack => ({
  ...emptyEnvironmentStack(),
  serverAttachmentId: "servers",
  ...fields,
});

function Strip({ initial }: { initial: EnvironmentStack }) {
  const [stack, setStack] = useState(initial);
  const patch = (change: Partial<EnvironmentStack>) =>
    setStack((current) => ({ ...current, ...change }));
  return (
    <SkillsPill
      projectId="proj-1"
      value={stack.skillSelection}
      onChange={(skillSelection) => patch({ skillSelection })}
      testId="pill"
      {...stackSkillChoices(stack, patch)}
    />
  );
}

const open = async () => {
  fireEvent.click(screen.getByTestId("pill"));
  await screen.findByLabelText("triage");
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSkills.mockResolvedValue([library("triage"), library("reply")]);
  mocks.serverSkills = [lookup];
  mocks.groups = [{ _id: "servers", serverIds: ["crm"] }];
});

describe("the Skills pill over a stack that carries server skills", () => {
  it("shows them, and removes one", async () => {
    render(
      <Strip initial={stackWith({ serverSkillSelection: picks("lookup") })} />,
    );
    expect(screen.getByTestId("pill")).toHaveTextContent("1 skill");
    await open();
    expect(screen.getByText("From MCP servers")).toBeInTheDocument();
    const row = screen.getByLabelText("acme-crm/lookup");
    expect(row).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row);
    expect(screen.getByTestId("pill")).toHaveTextContent("No skills");
  });

  it("lists one the project no longer holds, so it can be removed", async () => {
    mocks.serverSkills = [];
    render(
      <Strip initial={stackWith({ serverSkillSelection: picks("gone") })} />,
    );
    await open();
    fireEvent.click(
      screen.getByLabelText("Unavailable skill gone. Remove it."),
    );
    expect(screen.getByTestId("pill")).toHaveTextContent("No skills");
  });

  it("counts them toward the 20 a Library pick shares", async () => {
    mocks.serverSkills = [];
    const ids = Array.from({ length: 19 }, (_, index) => `server-${index}`);
    const triage = { mode: "explicit" as const, skillIds: ["triage"] };
    const { unmount } = render(
      <Strip
        initial={stackWith({
          skillSelection: triage,
          serverSkillSelection: picks(...ids),
        })}
      />,
    );
    await open();
    expect(screen.getByLabelText("reply")).toBeDisabled();
    unmount();

    // The same Library pick with no server skills still has room.
    render(<Strip initial={stackWith({ skillSelection: triage })} />);
    await open();
    expect(screen.getByLabelText("reply")).not.toBeDisabled();
  });

  it("offers no server section where the stack carries none", async () => {
    render(<Strip initial={stackWith({})} />);
    await open();
    expect(screen.queryByText("From MCP servers")).toBeNull();
  });

  it("keeps them when the scope is turned off", async () => {
    render(
      <Strip
        initial={stackWith({
          skillScope: "all-shared-library",
          serverSkillSelection: picks("lookup"),
        })}
      />,
    );
    expect(screen.getByTestId("pill")).toHaveTextContent(
      "All shared Library skills + 1",
    );
    fireEvent.click(screen.getByTestId("pill"));
    fireEvent.click(await screen.findByLabelText("All shared Library skills"));
    expect(screen.getByTestId("pill")).toHaveTextContent("1 skill");
  });
});

/**
 * The Skills field on the create-suite page: picks land on the composed
 * setup, so every environment the page creates carries them.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentComposerState } from "@/components/environment-composer/environment-stack";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  capabilities: { allSharedLibrarySkillScope: true } as Record<string, boolean>,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("@/components/environment-composer/use-composer-resolver", () => ({
  useComposerResolver: () => mocks.resolve,
}));
vi.mock("@/components/environment-composer/environment-composer", () => ({
  EnvironmentComposer: () => <div />,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [{ _id: "group", name: "Support", serverIds: ["crm"] }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "Claude Code" }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()],
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => mocks.capabilities,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({ useSkillsEnabled: () => true }));
vi.mock("@/components/project-environments/environment-picker", () => ({
  MAX_SUITE_ENVIRONMENTS: 10,
}));
vi.mock("../eval-target-matrix", () => ({ EvalTargetMatrix: () => <div /> }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: async () => [
    {
      skillId: "triage",
      name: "triage",
      description: "Sort a ticket",
      path: "Library",
      sharing: "project",
      origin: "cloud",
      pinnability: { ok: true },
    },
  ],
  listSkillVersions: async () => [],
}));
vi.mock("@/hooks/use-server-skills", () => ({
  useProjectServerSkills: () => [
    {
      id: "lookup",
      serverId: "crm",
      serverSlug: "acme-crm",
      ref: "acme-crm/lookup",
      name: "lookup",
      description: "Find a customer",
      versionId: "lookup-v1",
      versionNumber: 1,
    },
  ],
  useServerSkillVersions: () => undefined,
}));

import { CreateSuitePage } from "../create-suite-page";

const renderPage = () =>
  render(
    <CreateSuitePage
      onCancel={vi.fn()}
      onSubmit={vi.fn(async () => {})}
      hostsEnabled
      projectId="project"
    />,
  );
/** The setup Continue resolves into environments. */
const submittedStack = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("create-suite-continue")).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByTestId("create-suite-continue"));
  await waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1));
  return (mocks.resolve.mock.calls[0][0] as { state: EnvironmentComposerState })
    .state.stack;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilities = { allSharedLibrarySkillScope: true };
  mocks.resolve.mockResolvedValue({
    environmentIds: ["env-1"],
    environments: [{ environmentId: "env-1", hostId: "host-1" }],
    createdIds: ["env-1"],
    reusedIds: [],
    skipped: [],
  });
});

describe("Create suite Skills field", () => {
  it("puts Library and MCP-server picks on the setup the page creates", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("suite-clients-skills"));
    fireEvent.click(await screen.findByLabelText("triage"));
    fireEvent.click(screen.getByLabelText("acme-crm/lookup"));
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "2 skills",
    );
    const stack = await submittedStack();
    expect(stack.serverAttachmentId).toBe("group");
    expect(stack.skillSelection).toEqual({
      mode: "explicit",
      skillIds: ["triage"],
    });
    expect(stack.serverSkillSelection).toEqual({
      mode: "explicit",
      serverSkillIds: ["lookup"],
    });
  });

  it("puts the All shared Library skills scope on the setup", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("suite-clients-skills"));
    fireEvent.click(await screen.findByLabelText("triage"));
    fireEvent.click(screen.getByLabelText("All shared Library skills"));
    const stack = await submittedStack();
    expect(stack.skillScope).toBe("all-shared-library");
    expect(stack.skillSelection).toBeNull();
  });

  it("offers no scope where the backend can't store it", async () => {
    mocks.capabilities = {};
    renderPage();
    fireEvent.click(screen.getByTestId("suite-clients-skills"));
    await screen.findByLabelText("triage");
    expect(screen.queryByLabelText("All shared Library skills")).toBeNull();
  });
});

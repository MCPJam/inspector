/**
 * The Skills field's "All shared Library skills" choice and its "From MCP
 * servers" section, rendered inside `SuiteClientsSettings` so each click
 * saves through the same derivation as a Library pick.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { ProjectServerSkill } from "@/hooks/use-server-skills";
import { createFetchResponse } from "@/test/factories";
import type { EvalSuite } from "../types";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  environments: [] as ProjectEnvironmentView[],
  capabilities: {} as Record<string, boolean>,
  listSkills: vi.fn(),
  serverSkills: [] as ProjectServerSkill[],
  groups: [] as { _id: string; serverIds: string[] }[],
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => mocks.save,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "chat", name: "MCPJam agent", hostConfigId: "chat-config" },
      { hostId: "codex", name: "Codex", hostConfigId: "codex-config" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mocks.environments,
  useEnsureAdhocEnvironments: () => vi.fn(),
}));
vi.mock("@/components/environment-composer/use-eval-compose-capable", () => ({
  useEvalComposeCapable: () => ({ capable: true, pending: false }),
}));
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => mocks.capabilities,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({ useSkillsEnabled: () => true }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/session-token", () => ({
  authFetch: async () => createFetchResponse({ deliveredCount: 0, skills: [] }),
}));
vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: mocks.listSkills,
  listSkillVersions: async () => [],
}));
vi.mock("@/hooks/use-server-skills", () => ({
  useProjectServerSkills: () => mocks.serverSkills,
  useServerSkillVersions: (id: string, enabled: boolean) =>
    enabled
      ? [2, 1].map((n) => ({
          id: `${id}-v${n}`,
          versionNumber: n,
          capturedAt: n,
        }))
      : undefined,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mocks.groups,
    isLoading: false,
  }),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <button type="button">Server group</button>,
}));
vi.mock("../../evaluate/eval-target-matrix", () => ({
  EvalTargetMatrix: () => <div data-testid="client-table" />,
}));

import { SuiteClientsSettings } from "../suite-clients-settings";

const scope = "all-shared-library" as const;
const suite = {
  _id: "suite",
  name: "Suite",
  environmentIds: ["chat-env", "codex-env"],
} as EvalSuite;
const both = (fields: Partial<ProjectEnvironmentView> = {}) => {
  mocks.environments = [
    ["chat-env", "chat", 3],
    ["codex-env", "codex", 5],
  ].map(
    ([environmentId, hostId, revision]) =>
      ({
        environmentId,
        hostId,
        revision,
        modelId: "gpt",
        serverAttachmentId: "servers",
        ...fields,
      }) as ProjectEnvironmentView,
  );
};
const library = (skillId: string, shared = true) => ({
  skillId,
  name: skillId,
  description: `${skillId} description`,
  path: "Library",
  sharing: shared ? ("project" as const) : ("user" as const),
  origin: "cloud" as const,
  pinnability: shared
    ? { ok: true as const }
    : { ok: false as const, reason: "not_shared" },
  currentVersionNumber: 2,
});
const serverSkill = (
  id: string,
  serverId: string,
  extra: Partial<ProjectServerSkill> = {},
): ProjectServerSkill => ({
  id,
  serverId,
  serverSlug: serverId === "crm" ? "acme-crm" : "billing",
  ref: `${serverId === "crm" ? "acme-crm" : "billing"}/${id}`,
  name: id,
  description: `${id} description`,
  versionId: `${id}-v2`,
  versionNumber: 2,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue({});
  mocks.capabilities = {
    environmentDerivation: true,
    allSharedLibrarySkillScope: true,
  };
  both();
  mocks.listSkills.mockResolvedValue([
    library("triage"),
    library("reply"),
    library("notes", false),
  ]);
  mocks.serverSkills = [];
  mocks.groups = [{ _id: "servers", serverIds: ["crm"] }];
});

const renderSettings = () =>
  render(<SuiteClientsSettings suite={suite} projectId="project" />);
const openSkills = async () => {
  fireEvent.click(screen.getByTestId("suite-clients-skills"));
  await screen.findByLabelText("triage");
};
/** The overrides of each environment the save derives; kept ones are left out. */
const savedOverrides = async () => {
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  return mocks.save.mock.calls[0][0].targets.flatMap(
    (target: { derive?: { overrides: unknown } }) =>
      target.derive ? [target.derive.overrides] : [],
  );
};

describe("All shared Library skills", () => {
  it("is offered only where the backend stores the scope", async () => {
    mocks.capabilities = { environmentDerivation: true };
    renderSettings();
    await openSkills();
    expect(screen.queryByLabelText("All shared Library skills")).toBeNull();
  });

  it("turns on for every client in place of the picked list", async () => {
    both({ skillSelection: { mode: "explicit", skillIds: ["triage"] } });
    renderSettings();
    await openSkills();
    fireEvent.click(screen.getByLabelText("All shared Library skills"));
    expect(await savedOverrides()).toEqual([
      { skillScope: scope, skillSelection: null },
      { skillScope: scope, skillSelection: null },
    ]);
  });

  it("runs every shared skill at Latest, and keeps the others as a fixed list when one is unchecked", async () => {
    both({ skillScope: scope });
    const view = renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "All shared Library skills",
    );
    await openSkills();
    expect(screen.getByLabelText("All shared Library skills")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("triage")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("notes")).toBeDisabled();
    expect(screen.queryByLabelText("Version for triage")).toBeNull();
    fireEvent.click(screen.getByLabelText("reply"));
    expect(await savedOverrides()).toEqual([
      {
        skillScope: null,
        skillSelection: { mode: "explicit", skillIds: ["triage"] },
      },
      {
        skillScope: null,
        skillSelection: { mode: "explicit", skillIds: ["triage"] },
      },
    ]);
    both({ skillSelection: { mode: "explicit", skillIds: ["triage"] } });
    view.rerender(<SuiteClientsSettings suite={suite} projectId="project" />);
    expect(
      await screen.findByText(
        "Changed to a fixed list. New Library skills won’t join future runs.",
      ),
    ).toBeInTheDocument();
  });

  it("won't uncheck one when the list left would pass the cap, and says why", async () => {
    mocks.listSkills.mockResolvedValue(
      Array.from({ length: 22 }, (_, index) => library(`skill-${index}`)),
    );
    both({ skillScope: scope });
    renderSettings();
    fireEvent.click(screen.getByTestId("suite-clients-skills"));
    const first = await screen.findByLabelText("skill-0");
    expect(first).toBeDisabled();
    expect(
      screen.getByText(
        "Leaving one out would make a list of 21 skills, over the limit of 20. Turn this off to pick skills one by one.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(first);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reads Mixed skills when only some clients are on the scope", async () => {
    mocks.environments = [
      { ...mocks.environments[0]!, skillScope: scope },
      mocks.environments[1]!,
    ];
    renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "Mixed skills",
    );
    await openSkills();
    expect(screen.getByLabelText("All shared Library skills")).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
    // The scoped client has it; checking it adds it to the other one only.
    fireEvent.click(screen.getByLabelText("triage"));
    expect(await savedOverrides()).toEqual([
      { skillSelection: { mode: "explicit", skillIds: ["triage"] } },
    ]);
  });
});

describe("From MCP servers", () => {
  beforeEach(() => {
    mocks.serverSkills = [
      serverSkill("lookup", "crm"),
      serverSkill("broken", "crm", { unpinnable: { reason: "no_resources" } }),
      serverSkill("invoices", "billing"),
    ];
  });

  it("lists skills from the suite's servers with the server they came from", async () => {
    renderSettings();
    await openSkills();
    expect(screen.getByText("From MCP servers")).toBeInTheDocument();
    expect(screen.getByLabelText("acme-crm/lookup")).not.toBeDisabled();
    expect(screen.getAllByText("acme-crm")).toHaveLength(2);
    expect(screen.getByLabelText("acme-crm/broken")).toBeDisabled();
    expect(
      screen.getByText(/Its server lists no files for this skill/),
    ).toBeInTheDocument();
    // Its server isn't in the suite's group, so no environment would take it.
    expect(screen.queryByLabelText("billing/invoices")).toBeNull();
  });

  it("saves a pick on every client, and pins a captured version", async () => {
    const view = renderSettings();
    await openSkills();
    fireEvent.click(screen.getByLabelText("acme-crm/lookup"));
    const lookup = { mode: "explicit", serverSkillIds: ["lookup"] };
    expect(await savedOverrides()).toEqual([
      { serverSkillSelection: lookup },
      { serverSkillSelection: lookup },
    ]);
    mocks.save.mockClear();
    both({
      serverSkillSelection: { mode: "explicit", serverSkillIds: ["lookup"] },
    });
    view.rerender(<SuiteClientsSettings suite={suite} projectId="project" />);
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "1 skill",
    );
    const version = await screen.findByLabelText("Version for acme-crm/lookup");
    expect(version).toHaveDisplayValue("Latest (v2)");
    fireEvent.focus(version);
    await screen.findByText("v1");
    fireEvent.change(version, { target: { value: "lookup-v1" } });
    expect(await savedOverrides()).toEqual(
      Array(2).fill({
        serverSkillSelection: {
          ...lookup,
          versionPins: [{ serverSkillId: "lookup", versionId: "lookup-v1" }],
        },
      }),
    );
  });

  it("keeps a picked skill removable after its server leaves the group", async () => {
    both({
      skillScope: scope,
      serverSkillSelection: { mode: "explicit", serverSkillIds: ["invoices"] },
    });
    renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "All shared Library skills + 1",
    );
    await openSkills();
    const invoices = screen.getByLabelText("billing/invoices");
    expect(
      screen.getByText(/Its server isn’t in every client’s server group/),
    ).toBeInTheDocument();
    fireEvent.click(invoices);
    expect(await savedOverrides()).toEqual([
      { serverSkillSelection: null },
      { serverSkillSelection: null },
    ]);
  });
});

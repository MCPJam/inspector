/**
 * The Skills field in a suite's "Where it runs" row and the hint lines under
 * its client table, rendered inside `SuiteClientsSettings` so a pick saves
 * through the same `commit` and `planSuiteClients` as the Servers pick.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { PaneSkillsPreview } from "@/shared/pane-skills-preview";
import { createFetchResponse } from "@/test/factories";
import type { EvalSuite } from "../types";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  error: vi.fn(),
  flag: true,
  environments: [] as ProjectEnvironmentView[],
  capabilities: null as { environmentDerivation?: boolean } | null,
  listSkills: vi.fn(),
  authFetch: vi.fn(),
  previews: {} as Record<string, PaneSkillsPreview>,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => mocks.save,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "chat", name: "MCPJam agent" },
      { hostId: "codex", name: "Codex" },
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
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => mocks.flag,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: mocks.listSkills,
  listSkillVersions: async () => [],
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <button type="button">Server group</button>,
}));
vi.mock("../../evaluate/eval-target-matrix", () => ({
  EvalTargetMatrix: () => <div data-testid="client-table" />,
}));

import { SuiteClientsSettings } from "../suite-clients-settings";

const suite = {
  _id: "suite",
  name: "Suite",
  environmentIds: ["chat-env", "codex-env"],
} as EvalSuite;
const environment = (
  environmentId: string,
  hostId: string,
  revision: number,
  skillSelection?: ProjectEnvironmentView["skillSelection"],
) =>
  ({
    environmentId,
    hostId,
    modelId: "gpt",
    serverAttachmentId: "servers",
    revision,
    ...(skillSelection ? { skillSelection } : {}),
  }) as ProjectEnvironmentView;
const library = (skillId: string, name: string) => ({
  skillId,
  name,
  description: `${name} description`,
  path: "Library",
  sharing: "project" as const,
  origin: "cloud" as const,
  pinnability: { ok: true as const },
  currentVersionNumber: 2,
});
const row = (
  name: string,
  reason: PaneSkillsPreview["skills"][number]["reason"] = null,
  channels: PaneSkillsPreview["skills"][number]["channels"] = ["environment"],
) => ({ skillId: name, name, description: "", channels, reason });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag = true;
  mocks.capabilities = { environmentDerivation: true };
  mocks.environments = [
    environment("chat-env", "chat", 3),
    environment("codex-env", "codex", 5),
  ];
  mocks.save.mockResolvedValue({});
  mocks.listSkills.mockResolvedValue([
    library("triage", "triage"),
    library("reply", "reply"),
    {
      ...library("notes", "my-notes"),
      sharing: "user" as const,
      pinnability: { ok: false as const, reason: "not_shared" },
    },
  ]);
  mocks.previews = {};
  mocks.authFetch.mockImplementation(
    async (_url: string, init: RequestInit) => {
      const { target } = JSON.parse(String(init.body));
      return createFetchResponse(
        mocks.previews[target.environmentId] ?? {
          deliveredCount: 0,
          skills: [],
        },
      );
    },
  );
});

const renderSettings = () =>
  render(<SuiteClientsSettings suite={suite} projectId="project" />);
const openSkills = async () => {
  fireEvent.click(screen.getByTestId("suite-clients-skills"));
  return screen.findByLabelText("triage");
};
const savedTargets = () => mocks.save.mock.calls[0][0].targets;

describe("Skills field", () => {
  it("is hidden, with no hints and no preview reads, without skills-enabled", () => {
    mocks.flag = false;
    renderSettings();
    expect(screen.queryByTestId("suite-clients-skills")).toBeNull();
    expect(screen.queryByTestId("suite-skills-hints")).toBeNull();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });

  it("saves a pick on every client in one derive call", async () => {
    renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "No skills",
    );
    fireEvent.click(await openSkills());
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith({
      suiteId: "suite",
      expectedEnvironmentIds: ["chat-env", "codex-env"],
      targets: [
        {
          derive: {
            sourceEnvironmentId: "chat-env",
            expectedRevision: 3,
            overrides: {
              skillSelection: { mode: "explicit", skillIds: ["triage"] },
            },
          },
          replaces: "chat-env",
        },
        {
          derive: {
            sourceEnvironmentId: "codex-env",
            expectedRevision: 5,
            overrides: {
              skillSelection: { mode: "explicit", skillIds: ["triage"] },
            },
          },
          replaces: "codex-env",
        },
      ],
    });
  });

  it("clears the last skill with null", async () => {
    const triage = { mode: "explicit" as const, skillIds: ["triage"] };
    mocks.environments = [
      environment("chat-env", "chat", 3, triage),
      environment("codex-env", "codex", 5, triage),
    ];
    renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "1 skill",
    );
    const box = await openSkills();
    expect(box).toHaveAttribute("aria-checked", "true");
    fireEvent.click(box);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(
      savedTargets().map(
        (target: { derive: { overrides: unknown } }) => target.derive.overrides,
      ),
    ).toEqual([{ skillSelection: null }, { skillSelection: null }]);
  });

  it("reads Mixed skills for a mixed suite, and a click sets that skill on every client", async () => {
    mocks.environments = [
      environment("chat-env", "chat", 3, {
        mode: "explicit",
        skillIds: ["triage", "reply"],
        versionPins: [{ skillId: "reply", versionId: "reply-v1" }],
      }),
      environment("codex-env", "codex", 5, {
        mode: "explicit",
        skillIds: ["triage"],
      }),
    ];
    renderSettings();
    expect(screen.getByTestId("suite-clients-skills")).toHaveTextContent(
      "Mixed skills",
    );
    expect(screen.getByTestId("suite-skills-mixed-hint")).toHaveTextContent(
      "These clients use different skills or versions. Checking a skill here sets it at Latest on every client, and clearing one removes it from every client.",
    );
    expect(await openSkills()).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(
        "Checking a skill here sets it at Latest on every client, and clearing one removes it from every client.",
      ),
    ).toBeInTheDocument();
    const reply = screen.getByLabelText("reply");
    expect(reply).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(reply);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    // Both clients end on reply at Latest; each keeps its own other skills.
    expect(
      savedTargets().map(
        (target: { derive: { overrides: unknown } }) => target.derive.overrides,
      ),
    ).toEqual([
      { skillSelection: { mode: "explicit", skillIds: ["triage", "reply"] } },
      { skillSelection: { mode: "explicit", skillIds: ["triage", "reply"] } },
    ]);
  });

  it("is read only, and says why, where the backend can't derive", async () => {
    mocks.capabilities = { environmentDerivation: false };
    renderSettings();
    const triage = await openSkills();
    expect(
      screen.getByText(/can’t save skill changes from this page/),
    ).toBeInTheDocument();
    expect(triage).toBeDisabled();
    fireEvent.click(triage);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("shows a personal skill disabled, with the reason", async () => {
    renderSettings();
    await openSkills();
    expect(screen.getByLabelText("my-notes")).toBeDisabled();
    expect(
      screen.getByText(
        /Personal skill\. Only skills in the project library can run in environments\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("Skills hints", () => {
  it("read one environment preview per client and leave server skills out", async () => {
    mocks.previews = {
      "chat-env": { deliveredCount: 1, skills: [row("triage")] },
      "codex-env": {
        deliveredCount: 1,
        skills: [
          row("triage"),
          row("Reply", "invalid-skill-name"),
          row("acme/lookup", "server-skill-unsupported", ["mcp-server"]),
        ],
      },
    };
    renderSettings();
    expect(
      await screen.findByText("MCPJam agent and Codex load triage."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Codex can’t use the name Reply, so its runs leave it out.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/acme/)).toBeNull();
    expect(
      mocks.authFetch.mock.calls.map(([url, init]) => [
        url,
        JSON.parse(String((init as RequestInit).body)),
      ]),
    ).toEqual([
      [
        "/api/web/environments/skills-preview",
        {
          projectId: "project",
          target: { kind: "environment", environmentId: "chat-env" },
        },
      ],
      [
        "/api/web/environments/skills-preview",
        {
          projectId: "project",
          target: { kind: "environment", environmentId: "codex-env" },
        },
      ],
    ]);
  });

  it("says when the previews fail, and reads them again on Retry", async () => {
    mocks.previews = {
      "chat-env": { deliveredCount: 1, skills: [row("triage")] },
      "codex-env": { deliveredCount: 1, skills: [row("triage")] },
    };
    mocks.authFetch.mockResolvedValueOnce(createFetchResponse({}, 500));
    renderSettings();
    expect(
      await screen.findByText(
        "Couldn’t check which clients load these skills. Try again.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Every client loads triage."),
    ).toBeInTheDocument();
  });
});

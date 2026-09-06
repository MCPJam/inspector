import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  emptyComposerState,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import type { CloudServerBlockCopy } from "@/lib/cloud-server-readiness";

const { navigateAppMock } = vi.hoisted(() => ({ navigateAppMock: vi.fn() }));

const flagState = vi.hoisted(() => ({
  skills: false,
  computers: false,
  environments: true,
}));

vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => flagState.skills,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => flagState.computers,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.environments,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => [
    {
      environmentId: "sandbox-1",
      name: "Base box",
      sharing: "project",
      currentBuild: { status: "ready" },
    },
  ],
}));
const cloudState = vi.hoisted(() => ({
  ephemeralAvailable: true as boolean | undefined,
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => cloudState.ephemeralAvailable,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    // Two, because the multi-environment fixtures below reference both — a
    // one-host list made a second environment's client unmanipulable.
    hosts: [
      { hostId: "host-1", name: "Claude" },
      { hostId: "host-2", name: "Cursor" },
    ],
    isLoading: false,
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({
    query: vi.fn(async () => ({ modelMatrix: false })),
  }),
}));
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({
    value,
    onChange,
    triggerTestId,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    triggerTestId?: string;
  }) => (
    <>
      <button
        type="button"
        data-testid={triggerTestId}
        onClick={() => onChange(value.length ? [] : ["env-1"])}
      >
        {value.length ? `${value.length} environment` : "pick environment"}
      </button>
      {/* Adds a SECOND environment without clearing the first, so the
          seed-from-the-whole-selection contract is drivable. */}
      <button
        type="button"
        data-testid="mock-add-second-environment"
        onClick={() => onChange([...value, "env-2"])}
      />
    </>
  ),
}));
vi.mock(
  "@/components/project-environments/ProjectEnvironmentSkillsPicker",
  () => ({
    ProjectEnvironmentSkillsPicker: () => (
      <p className="italic">
        No skills in the project library yet. Add a skill to the library to
        pin it here.
      </p>
    ),
  })
);
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: navigateAppMock,
  routePaths: {
    hosts: "/hosts",
    environments: "/environments",
    servers: "/servers",
  },
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmTargetComposer } from "../swarm-target-composer";
import { listTentativeCastles } from "@/lib/tentative-castle-drafts";

function Harness({
  environments = [
    {
      environmentId: "env-1",
      projectId: "proj-1",
      name: "Prod-like",
      hostId: "host-1",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  onChange,
  serverBlock,
}: {
  environments?: Array<{
    environmentId: string;
    projectId: string;
    name: string;
    hostId: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
    pluginVersionIds?: string[];
  }>;
  onChange?: (next: EnvironmentComposerState) => void;
  serverBlock?: CloudServerBlockCopy | null;
}) {
  const [value, setValue] = useState<EnvironmentComposerState>(
    emptyComposerState
  );
  return (
    <SwarmTargetComposer
      projectId="proj-1"
      environments={environments}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      draftNameHint="Billing"
      serverBlock={serverBlock}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  flagState.skills = false;
  flagState.computers = false;
  flagState.environments = true;
  cloudState.ephemeralAvailable = true;
});

describe("SwarmTargetComposer", () => {
  it("seeds stack from a selected environment and marks custom after client edits", () => {
    let latest: EnvironmentComposerState | null = null;
    render(<Harness onChange={(next) => (latest = next)} />);
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(screen.getByTestId("new-swarm-clients-picker")).toHaveTextContent(
      /claude/i
    );
    expect(latest?.customized).toBe(false);

    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    // Toggle off the seeded client to mark customized.
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    expect(latest?.customized).toBe(true);
  });

  it("blocks stack edits when a selected environment pins plugin versions", () => {
    // The stack has no plugin slot and the resolver never reuses a pinned named
    // row, so an edit would silently run without the pins. The picker stays
    // usable — changing the selection is the way out.
    render(
      <Harness
        environments={[
          {
            environmentId: "env-1",
            projectId: "proj-1",
            name: "Prod-like",
            hostId: "host-1",
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            pluginVersionIds: ["pv-1"],
          },
        ]}
      />
    );
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(screen.getByTestId("new-swarm-clients-picker")).toBeDisabled();
    expect(screen.getByTestId("new-swarm-collapse-hint")).toHaveTextContent(
      /pins plugin versions/i
    );
    expect(screen.getByTestId("new-swarm-environments-picker")).toBeEnabled();
  });

  it("saves a tentative draft from the lego strip", () => {
    render(<Harness environments={[]} />);
    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    fireEvent.click(screen.getByTestId("new-swarm-save-draft"));
    expect(listTentativeCastles("proj-1")).toHaveLength(1);
    expect(listTentativeCastles("proj-1")[0]).toMatchObject({
      name: "Billing",
      hostIds: ["host-1"],
    });
  });

  it("hides the models pill so New Swarm does not change product", () => {
    render(<Harness />);
    expect(screen.queryByTestId("new-swarm-models-picker")).toBeNull();
    expect(screen.getByTestId("new-swarm-clients-picker")).toBeVisible();
  });

  it("hides the environments picker when project-environments-enabled is off", () => {
    flagState.environments = false;
    render(<Harness />);
    expect(
      screen.queryByTestId("new-swarm-environments-picker")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-clients-picker")).toBeVisible();
  });

  it("hides skills UI when skills-enabled is off", () => {
    flagState.skills = false;
    render(<Harness />);
    expect(
      screen.queryByTestId("new-swarm-skills-picker")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No skills in the project library yet/i)
    ).not.toBeInTheDocument();
  });

  it("shows a skills pill (not bare empty text) when skills-enabled is on", () => {
    flagState.skills = true;
    render(<Harness />);
    const trigger = screen.getByTestId("new-swarm-skills-picker");
    expect(trigger).toBeVisible();
    expect(trigger).toHaveTextContent(/No skills · pick some/i);
    expect(
      screen.queryByText(/No skills in the project library yet/i)
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(
      screen.getByText(/No skills in the project library yet/i)
    ).toBeVisible();
  });

  it("hides the computer select when computers-enabled is off", () => {
    flagState.computers = false;
    render(<Harness />);
    expect(
      screen.queryByTestId("new-swarm-sandbox-image")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Computer · default/i)).not.toBeInTheDocument();
  });

  it("shows the computer select when computers-enabled is on", () => {
    flagState.computers = true;
    render(<Harness />);
    expect(screen.getByTestId("new-swarm-sandbox-image")).toBeVisible();
    expect(screen.getByTestId("new-swarm-sandbox-image")).toHaveTextContent(
      /Computer · default/i
    );
  });

  it("labels computer execution as MCPJam cloud when computers are on", () => {
    flagState.computers = true;
    render(<Harness />);
    expect(screen.getByTestId("new-swarm-cloud-run-badge")).toBeVisible();
  });

  it("shows no cloud badge when computers are off", () => {
    render(<Harness />);
    expect(
      screen.queryByTestId("new-swarm-cloud-run-badge")
    ).not.toBeInTheDocument();
  });

  it("blocks NEW sandbox-image pins but keeps the clear path when cloud is unreachable", async () => {
    // `false` means a sandbox-backed session WOULD fail per-attempt — the
    // composer must warn and disable the opt-in. But the PICKER stays live:
    // a pin seeded from a saved environment/draft must remain clearable back
    // to "Computer · default" (the opt-out the notice promises).
    flagState.computers = true;
    cloudState.ephemeralAvailable = false;
    render(<Harness />);
    expect(screen.getByTestId("new-swarm-cloud-unreachable")).toBeVisible();
    expect(screen.getByTestId("new-swarm-sandbox-image")).not.toBeDisabled();

    // The rows only exist while the dropdown is open, and Radix marks a
    // disabled one with aria-disabled rather than a native `disabled` prop.
    fireEvent.click(screen.getByTestId("new-swarm-sandbox-image"));
    expect(
      await screen.findByRole("option", { name: /Base box/i })
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("option", { name: /Computer · default/i })
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("stays quiet while cloud availability is still loading", () => {
    // Loading/fetch-failure must never paint the warning — only a real
    // server `false` may.
    flagState.computers = true;
    cloudState.ephemeralAvailable = undefined;
    render(<Harness />);
    expect(
      screen.queryByTestId("new-swarm-cloud-unreachable")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-sandbox-image")).not.toBeDisabled();
  });
});

/**
 * Seeding across a MULTI-environment selection. The stack's fan-out axis is
 * `hostIds`, so seeding only the newest environment's client means the first
 * later edit — which flips `customized` and hands resolution to the stack —
 * silently drops every other selected environment from the run.
 */
describe("SwarmTargetComposer — multi-environment seeding", () => {
  const twoEnvironments = [
    {
      environmentId: "env-1",
      projectId: "proj-1",
      name: "Prod-like",
      origin: "named",
      hostId: "host-1",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      environmentId: "env-2",
      projectId: "proj-1",
      name: "Staging",
      origin: "named",
      hostId: "host-2",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  it("blocks slot edits when the selection disagrees on a shared slot", () => {
    // A stack has ONE server group for all its clients, so an edit would resolve
    // both with defaults and replace each environment's execution context.
    const differentGroups = [
      { ...twoEnvironments[0], serverAttachmentId: "grp-1" },
      { ...twoEnvironments[1], serverAttachmentId: "grp-2" },
    ];
    render(<Harness environments={differentGroups as never} />);

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    fireEvent.click(screen.getByTestId("mock-add-second-environment"));

    expect(screen.getByTestId("new-swarm-collapse-hint")).toBeVisible();
    expect(screen.getByTestId("new-swarm-clients-picker")).toBeDisabled();
  });

  it("keeps EVERY selected environment's client in the stack", () => {
    render(<Harness environments={twoEnvironments as never} />);

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    fireEvent.click(screen.getByTestId("mock-add-second-environment"));

    // Both clients, not just the one added last.
    const clients = screen.getByTestId("new-swarm-clients-picker");
    expect(clients).toHaveTextContent(/claude/i);
    expect(clients).toHaveTextContent(/\+1/);
  });

  it("drops a removed environment's client from the stack", () => {
    render(<Harness environments={twoEnvironments as never} />);

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    fireEvent.click(screen.getByTestId("mock-add-second-environment"));
    // Customize, so the stack — not the selection — is what resolves.
    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));
    expect(screen.getByTestId("new-swarm-clients-picker")).toHaveTextContent(
      /claude/i,
    );

    // Detach every environment. Resolution goes through `hostIds`, so keeping
    // them would mean the detach did nothing and both clients still ran.
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(screen.getByTestId("new-swarm-clients-picker")).toHaveTextContent(
      /no clients/i,
    );
  });

  it("blocks slot edits when two selected environments share a client", () => {
    const sameHost = [
      { ...twoEnvironments[0] },
      { ...twoEnvironments[1], hostId: "host-1" },
    ];
    render(<Harness environments={sameHost as never} />);

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    fireEvent.click(screen.getByTestId("mock-add-second-environment"));

    // One host for two environments: an edit would resolve them to ONE row.
    expect(screen.getByTestId("new-swarm-collapse-hint")).toBeVisible();
    expect(screen.getByTestId("new-swarm-clients-picker")).toBeDisabled();
    // The way out stays open — the SELECTION is still editable.
    expect(
      screen.getByTestId("new-swarm-environments-picker"),
    ).not.toBeDisabled();
  });
});

/**
 * The copy module names a route key; this layer turns it into a destination.
 * Asserting the button exists would not catch an index that resolves to
 * undefined, which is the only way this mapping can be wrong.
 */
describe("SwarmTargetComposer — the block's way out", () => {
  it("sends the empty-project action to Servers", () => {
    navigateAppMock.mockClear();
    render(
      <Harness
        serverBlock={{
          message: "Claude has no servers to run against.",
          detail: "These sessions run against an MCP server.",
          tone: "guidance",
          action: { label: "Connect a server", route: "servers" },
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    expect(navigateAppMock).toHaveBeenCalledWith("/servers");
  });
});

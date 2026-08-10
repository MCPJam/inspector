import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  emptySwarmTargetComposerState,
  type SwarmTargetComposerState,
} from "../swarm-target-types";

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
    hosts: [{ hostId: "host-1", name: "Claude" }],
    isLoading: false,
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
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
    <button
      type="button"
      data-testid={triggerTestId}
      onClick={() => onChange(value.length ? [] : ["env-1"])}
    >
      {value.length ? `${value.length} environment` : "pick environment"}
    </button>
  ),
}));
vi.mock(
  "@/components/project-environments/ProjectEnvironmentSkillsPicker",
  () => ({
    ProjectEnvironmentSkillsPicker: () => (
      <p className="italic">
        No shared skills in this project yet. Share a skill with the project to
        pin it here.
      </p>
    ),
  })
);
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { hosts: "/hosts", environments: "/environments" },
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
}: {
  environments?: Array<{
    environmentId: string;
    projectId: string;
    name: string;
    hostId: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
  }>;
}) {
  const [value, setValue] = useState<SwarmTargetComposerState>(
    emptySwarmTargetComposerState
  );
  return (
    <SwarmTargetComposer
      projectId="proj-1"
      environments={environments}
      value={value}
      onChange={setValue}
      draftNameHint="Billing"
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
    render(<Harness />);
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(screen.getByTestId("new-swarm-clients-picker")).toHaveTextContent(
      /claude/i
    );
    expect(
      screen.queryByTestId("new-swarm-target-custom-badge")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    // Toggle off the seeded client to mark customized.
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));
    expect(screen.getByTestId("new-swarm-target-custom-badge")).toBeVisible();
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
      screen.queryByText(/No shared skills in this project yet/i)
    ).not.toBeInTheDocument();
  });

  it("shows a skills pill (not bare empty text) when skills-enabled is on", () => {
    flagState.skills = true;
    render(<Harness />);
    const trigger = screen.getByTestId("new-swarm-skills-picker");
    expect(trigger).toBeVisible();
    expect(trigger).toHaveTextContent(/No skills · pick some/i);
    expect(
      screen.queryByText(/No shared skills in this project yet/i)
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(
      screen.getByText(/No shared skills in this project yet/i)
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

  it("blocks the sandbox-image opt-in when cloud sandboxes are unreachable", () => {
    // `false` means a sandbox-backed session WOULD fail per-attempt — the
    // composer must warn and disable the opt-in instead of inviting it.
    flagState.computers = true;
    cloudState.ephemeralAvailable = false;
    render(<Harness />);
    expect(screen.getByTestId("new-swarm-cloud-unreachable")).toBeVisible();
    expect(screen.getByTestId("new-swarm-sandbox-image")).toBeDisabled();
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

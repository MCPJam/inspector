import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  emptySwarmTargetComposerState,
  type SwarmTargetComposerState,
} from "../swarm-target-types";

vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => [],
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
});

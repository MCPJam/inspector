/**
 * New swarm opens the Describe skeleton (not GenerateSwarmDialog).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    revision: 1,
  },
];

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [];
      case "journeys:listJourneysByPersona":
        return [];
      case "hosts:listHosts":
        return [];
      case "projectEnvironments:listEnvironments":
        return environments;
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn().mockResolvedValue(undefined),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
  };
});

vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => null,
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));

vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/components/mcpjam-agent/McpjamAgentComposer", () => ({
  McpjamAgentComposer: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Describe swarm"
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
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
      data-testid={triggerTestId ?? "environments-picker"}
      onClick={() => onChange(value.length ? [] : ["env-1"])}
    >
      {value.length ? `${value.length} env` : "pick env"}
    </button>
  ),
}));

import { SwarmsTab } from "../SwarmsTab";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SwarmsTab — New swarm create skeleton", () => {
  it("opens the Describe skeleton from New swarm and Cancel returns to Swarm", () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

    expect(
      screen.queryByTestId("new-swarm-describe-skeleton"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^new swarm$/i }));

    expect(
      screen.getByTestId("new-swarm-describe-skeleton"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /who uses this server, and what do they try to do/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Describe")).toBeInTheDocument();
    expect(screen.getByText("Confirm personas")).toBeInTheDocument();
    expect(
      screen.queryByTestId("swarms-tab-header-chrome"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /generate persona/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(
      screen.queryByTestId("new-swarm-describe-skeleton"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("swarms-tab-header-chrome"),
    ).toBeInTheDocument();
  });

  it("keeps Generate personas disabled until draft and an environment are set", () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByRole("button", { name: /^new swarm$/i }));

    const submit = screen.getByTestId("new-swarm-generate-personas");
    expect(submit).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText(
        /finance ops reconciling payouts/i,
      ),
      { target: { value: "Support agents answering refunds" } },
    );
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(submit).not.toBeDisabled();
  });

  it("lets the user pick How hard to push intensity", () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByRole("button", { name: /^new swarm$/i }));

    const group = screen.getByTestId("new-swarm-push-intensity");
    const quick = screen.getByRole("radio", { name: /quick look/i });
    const standard = screen.getByRole("radio", { name: /standard/i });
    const launch = screen.getByRole("radio", { name: /launch gate/i });

    expect(group).toBeInTheDocument();
    expect(quick).toHaveAttribute("aria-checked", "true");
    expect(standard).toHaveAttribute("aria-checked", "false");

    fireEvent.click(launch);
    expect(launch).toHaveAttribute("aria-checked", "true");
    expect(quick).toHaveAttribute("aria-checked", "false");
  });
});

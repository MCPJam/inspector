import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EnvironmentToolsPane } from "../panes/EnvironmentToolsPane";
import type { UseEnvironmentToolsResult } from "@/hooks/use-environment-tools";

const { useEnvironmentToolsMock } = vi.hoisted(() => ({
  useEnvironmentToolsMock: vi.fn(),
}));

vi.mock("@/hooks/use-environment-tools", () => ({
  useEnvironmentTools: useEnvironmentToolsMock,
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [
    { environmentId: "env_1", revision: 7 },
    { environmentId: "env_other", revision: 2 },
  ],
}));

function setTools(result: Partial<UseEnvironmentToolsResult>) {
  useEnvironmentToolsMock.mockReturnValue({
    servers: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...result,
  });
}

const SERVERS = [
  {
    serverId: "ps_1",
    name: "linear",
    source: "host_or_group" as const,
    tools: [
      {
        name: "list_issues",
        description: "List issues in a project",
        inputSchema: { type: "object", properties: {} },
      },
      { name: "search", description: "Search linear" },
    ],
  },
  {
    serverId: "ps_2",
    name: "asana",
    source: "plugin" as const,
    tools: [{ name: "search", description: "Search asana" }],
  },
];

describe("EnvironmentToolsPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("feeds the selected environment's revision into the tools hook", () => {
    setTools({ servers: SERVERS });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);
    expect(useEnvironmentToolsMock).toHaveBeenCalledWith("p_1", "env_1", 7);
  });

  it("renders every server's tools flat, badging only colliding names", () => {
    setTools({ servers: SERVERS });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);

    expect(screen.getByText("list_issues")).toBeInTheDocument();
    expect(screen.getAllByText("search")).toHaveLength(2);
    // `search` exists on both servers → both rows carry a server badge;
    // `list_issues` is unique → no badge.
    expect(screen.getByText("linear")).toBeInTheDocument();
    expect(screen.getByText("asana")).toBeInTheDocument();
    // Read-only pane: the browser-connection run/connect chrome never renders.
    expect(screen.queryByText("Run")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(
      screen.getByText(/connect automatically on every message/i),
    ).toBeInTheDocument();
  });

  it("filters by search across name and description", () => {
    setTools({ servers: SERVERS });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);

    fireEvent.change(screen.getByPlaceholderText("Search tools..."), {
      target: { value: "issues" },
    });
    expect(screen.getByText("list_issues")).toBeInTheDocument();
    expect(screen.queryAllByText("search")).toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText("Search tools..."), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No tools match your search")).toBeInTheDocument();
  });

  it("shows a per-server failure row while the healthy server's tools render", () => {
    setTools({
      servers: [
        SERVERS[0],
        { ...SERVERS[1], tools: [], error: "connect ECONNREFUSED" },
      ],
    });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);

    expect(screen.getByText("list_issues")).toBeInTheDocument();
    expect(
      screen.getByTestId("environment-tools-error-ps_2"),
    ).toHaveTextContent("asana: couldn't list tools");
  });

  it("shows the loading state until the first listing lands", () => {
    setTools({ servers: null, isLoading: true });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);
    expect(
      screen.getByText("Listing the environment's tools…"),
    ).toBeInTheDocument();
  });

  it("shows a route-level error", () => {
    setTools({ error: "This environment couldn't be resolved." });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);
    expect(
      screen.getByText("This environment couldn't be resolved."),
    ).toBeInTheDocument();
  });

  it("distinguishes zero tools from all-servers-failed", () => {
    setTools({ servers: [{ ...SERVERS[0], tools: [] }] });
    const { unmount } = render(
      <EnvironmentToolsPane projectId="p_1" environmentId="env_1" />,
    );
    expect(
      screen.getByText("This environment's servers expose no tools."),
    ).toBeInTheDocument();
    unmount();

    setTools({
      servers: [{ ...SERVERS[0], tools: [], error: "boom" }],
    });
    render(<EnvironmentToolsPane projectId="p_1" environmentId="env_1" />);
    expect(screen.getByText("No tools could be listed.")).toBeInTheDocument();
  });
});

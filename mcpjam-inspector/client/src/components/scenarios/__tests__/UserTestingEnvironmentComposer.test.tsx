import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyComposerState } from "@/components/environment-composer/environment-stack";
import type { CloudServerCatalogEntry } from "@/lib/cloud-server-readiness";

const { state, openPicker, navigate } = vi.hoisted(() => ({
  state: {
    hosts: [{ hostId: "cursor", name: "Cursor", serverCount: 0 }],
    servers: [] as CloudServerCatalogEntry[] | undefined,
    attachments: [] as Array<{
      _id: string;
      name: string;
      serverIds: string[];
    }>,
  },
  openPicker: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: state.hosts }),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: state.servers }),
  useProjectServerAttachments: () => ({ serverAttachments: state.attachments }),
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: navigate,
  routePaths: { servers: "/servers" },
}));
vi.mock("@/components/environment-composer/environment-composer", () => ({
  EnvironmentComposer: ({ disabled }: { disabled?: boolean }) => (
    <button
      data-testid="user-testing-create-servers-picker"
      disabled={disabled}
      onClick={openPicker}
    >
      Servers · client default
    </button>
  ),
}));

import { UserTestingEnvironmentComposer } from "../UserTestingEnvironmentComposer";

const remote = {
  _id: "server-1",
  name: "Docs",
  url: "https://mcp.example.com/mcp",
};

function props() {
  const value = emptyComposerState();
  value.stack.hostIds = ["cursor"];
  return {
    projectId: "project-1",
    environments: [],
    value,
    onChange: vi.fn(),
    hostsLoading: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.hosts = [{ hostId: "cursor", name: "Cursor", serverCount: 0 }];
  state.servers = [];
  state.attachments = [];
});

describe("UserTestingEnvironmentComposer server guidance", () => {
  it("shows the Swarms notice before Continue for an empty project", () => {
    render(<UserTestingEnvironmentComposer {...props()} />);

    const notice = screen.getByTestId("user-testing-create-servers-required");
    expect(notice).toHaveAttribute("data-tone", "guidance");
    expect(notice).toHaveTextContent("Cursor has no servers to run against.");
    expect(screen.queryByText("No server picked")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect a server" }));
    expect(navigate).toHaveBeenCalledWith("/servers");
  });

  it("opens the existing picker rather than navigating when a server is available", () => {
    state.servers = [remote];
    render(<UserTestingEnvironmentComposer {...props()} />);

    expect(screen.getByText(/Your project has Docs/)).toBeInTheDocument();
    expect(screen.queryByText("Connect a server")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose servers" }));
    expect(openPicker).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("clears the notice when the user selects a server group", () => {
    state.servers = [remote];
    state.attachments = [
      { _id: "group-1", name: "Docs", serverIds: [remote._id] },
    ];
    const initial = props();
    const { rerender } = render(
      <UserTestingEnvironmentComposer {...initial} />,
    );
    expect(
      screen.getByTestId("user-testing-create-servers-required"),
    ).toBeInTheDocument();

    rerender(
      <UserTestingEnvironmentComposer
        {...initial}
        value={{
          ...initial.value,
          stack: { ...initial.value.stack, serverAttachmentId: "group-1" },
        }}
      />,
    );
    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
  });

  it("accepts the client's existing default servers without requiring a new selection", () => {
    state.hosts = [{ hostId: "cursor", name: "Cursor", serverCount: 1 }];
    state.servers = [remote];
    render(<UserTestingEnvironmentComposer {...props()} />);

    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
  });

  it("follows the client's defaults when the selected client changes", () => {
    state.hosts.push({ hostId: "claude", name: "Claude", serverCount: 1 });
    const initial = props();
    const { rerender } = render(
      <UserTestingEnvironmentComposer {...initial} />,
    );
    expect(
      screen.getByText("Cursor has no servers to run against."),
    ).toBeInTheDocument();

    rerender(
      <UserTestingEnvironmentComposer
        {...initial}
        value={{
          ...initial.value,
          stack: { ...initial.value.stack, hostIds: ["claude"] },
        }}
      />,
    );
    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
  });

  it("does not show a server problem before any client is selected", () => {
    render(
      <UserTestingEnvironmentComposer
        {...props()}
        value={emptyComposerState()}
      />,
    );
    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
  });

  it("does not show a server problem while the host list is loading", () => {
    render(<UserTestingEnvironmentComposer {...props()} hostsLoading />);
    expect(
      screen.queryByTestId("user-testing-create-servers-required"),
    ).not.toBeInTheDocument();
  });

  it("does not mistake a loading server catalog for an empty project", () => {
    state.servers = undefined;
    render(<UserTestingEnvironmentComposer {...props()} />);

    expect(
      screen.getByText("Cursor has no servers attached yet."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connect a server")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose servers")).not.toBeInTheDocument();
  });

  it("explains reachability instead of offering an unusable server", () => {
    state.servers = [{ _id: "local", name: "Local", command: "node" }];
    render(<UserTestingEnvironmentComposer {...props()} />);

    expect(
      screen.getByText("Cursor has no servers this run can reach."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Expose one over HTTPS/)).toBeInTheDocument();
    expect(screen.queryByText("Choose servers")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect a server")).not.toBeInTheDocument();
  });

  it("does not offer navigation while the composer is disabled", () => {
    render(<UserTestingEnvironmentComposer {...props()} disabled />);
    expect(
      screen.getByTestId("user-testing-create-servers-required"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connect a server")).not.toBeInTheDocument();
  });
});

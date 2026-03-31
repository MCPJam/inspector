import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SandboxesTab } from "../SandboxesTab";
import { writeBuilderSession } from "@/lib/sandbox-session";

const mockBuilderViewProps = vi.fn();

const sandboxList = [
  {
    sandboxId: "sbx-1",
    workspaceId: "ws-1",
    name: "Alpha",
    description: "Alpha description",
    hostStyle: "claude" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["alpha-server"],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    sandboxId: "sbx-2",
    workspaceId: "ws-1",
    name: "Beta",
    description: "Beta description",
    hostStyle: "chatgpt" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["beta-server"],
    createdAt: 2,
    updatedAt: 2,
  },
];

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/useSandboxes", () => ({
  useSandboxList: () => ({
    sandboxes: sandboxList,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceQueries: () => ({
    workspaces: [
      {
        _id: "ws-1",
        name: "Workspace One",
      },
    ],
  }),
  useWorkspaceServers: () => ({
    servers: [],
  }),
}));

vi.mock("../sandboxes/builder/SandboxBuilderView", () => ({
  SandboxBuilderView: (props: any) => {
    mockBuilderViewProps(props);

    return (
      <div>
        <h2>Builder view</h2>
        <p>Sandbox: {props.sandboxId ?? "new"}</p>
        <p>Draft: {props.draft?.name ?? "none"}</p>
        <p>Workspace: {props.workspaceName ?? "unknown"}</p>
        <p>View mode: {props.initialViewMode ?? "none"}</p>
        <button type="button" onClick={props.onBack}>
          Back to index
        </button>
      </div>
    );
  },
}));

describe("SandboxesTab", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("shows a workspace prompt when no workspace is selected", () => {
    render(<SandboxesTab workspaceId={null} />);

    expect(
      screen.getByText("Select a workspace to manage sandboxes."),
    ).toBeInTheDocument();
  });

  it("renders the sandbox index once the builder experience loads", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Sandboxes" },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("opens the clicked sandbox in the builder view", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(await screen.findByText("Beta", {}, { timeout: 3000 }));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("Workspace: Workspace One")).toBeInTheDocument();
  });

  it("opens the starter launcher from the new sandbox action", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));

    expect(
      await screen.findByText("What would you like to create?"),
    ).toBeInTheDocument();
  });

  it("starts a blank sandbox draft after choosing blank from the launcher", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));
    fireEvent.click(await screen.findByText("Blank sandbox"));

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: new")).toBeInTheDocument();
    expect(screen.getByText("Draft: New Sandbox")).toBeInTheDocument();
  });

  it("restores the saved builder session for the active workspace", async () => {
    writeBuilderSession({
      workspaceId: "ws-1",
      sandboxId: "sbx-2",
      draft: null,
      viewMode: "preview",
    });

    render(<SandboxesTab workspaceId="ws-1" />);

    expect(await screen.findByText("Builder view")).toBeInTheDocument();
    expect(screen.getByText("Sandbox: sbx-2")).toBeInTheDocument();
    expect(screen.getByText("View mode: preview")).toBeInTheDocument();
  });

  it("returns to the sandbox index after leaving the builder", async () => {
    render(<SandboxesTab workspaceId="ws-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "New sandbox" }));
    fireEvent.click(await screen.findByText("Blank sandbox"));
    fireEvent.click(screen.getByRole("button", { name: "Back to index" }));

    expect(
      await screen.findByRole("heading", { name: "Sandboxes" }),
    ).toBeInTheDocument();
  });
});

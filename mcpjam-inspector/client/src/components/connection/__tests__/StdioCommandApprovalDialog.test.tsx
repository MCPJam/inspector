import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  formatStdioCommandLine,
  StdioCommandApprovalDialog,
} from "../StdioCommandApprovalDialog";
import { useStdioCommandApprovalStore } from "@/lib/stdio-command-approval";

const TERMS = {
  serverId: "srv-1",
  fingerprint: "ab".repeat(32),
  command: "npx",
  args: ["-y", "@acme/files-mcp", "--root", "/home/me/my docs"],
  envNames: ["ACME_TOKEN", "LOG_LEVEL"],
  cwd: "/home/me",
  previouslyApproved: false,
};

describe("formatStdioCommandLine", () => {
  it("quotes only the words a shell would need quoted", () => {
    expect(formatStdioCommandLine("npx", ["-y", "pkg", "a b", ""])).toBe(
      'npx -y pkg "a b" ""',
    );
  });
});

describe("StdioCommandApprovalDialog", () => {
  beforeEach(() => {
    useStdioCommandApprovalStore.setState({ queue: [] });
  });

  it("renders nothing while no approval is pending", () => {
    render(<StdioCommandApprovalDialog />);
    expect(screen.queryByTestId("stdio-command-approval-dialog")).toBeNull();
  });

  it("shows the command, the env names and the working directory, and allows", async () => {
    const user = userEvent.setup();
    const outcome = useStdioCommandApprovalStore
      .getState()
      .request({ projectId: "proj-1", serverName: "Files", terms: TERMS });

    render(<StdioCommandApprovalDialog />);

    expect(
      screen.getByRole("heading", { name: 'Run "Files" on this machine?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('npx -y @acme/files-mcp --root "/home/me/my docs"'),
    ).toBeInTheDocument();
    expect(screen.getByText("ACME_TOKEN, LOG_LEVEL")).toBeInTheDocument();
    expect(screen.getByText("/home/me")).toBeInTheDocument();
    expect(
      screen.getByText(/has not started "Files" before/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Allow on this device" }),
    );
    expect(await outcome).toBe(true);
    expect(useStdioCommandApprovalStore.getState().queue).toEqual([]);
  });

  it("says the command changed when this device had approved an older one, and declines", async () => {
    const user = userEvent.setup();
    const outcome = useStdioCommandApprovalStore.getState().request({
      projectId: "proj-1",
      serverName: "Files",
      terms: { ...TERMS, previouslyApproved: true },
    });

    render(<StdioCommandApprovalDialog />);

    expect(
      screen.getByText(/has changed since you approved it on this device/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await outcome).toBe(false);
  });

  it("answers one prompt at a time, in order", async () => {
    const user = userEvent.setup();
    const store = useStdioCommandApprovalStore.getState();
    const first = store.request({
      projectId: "proj-1",
      serverName: "Files",
      terms: TERMS,
    });
    const second = store.request({
      projectId: "proj-1",
      serverName: "Search",
      terms: { ...TERMS, serverId: "srv-2", envNames: [] },
    });

    render(<StdioCommandApprovalDialog />);

    expect(
      screen.getByRole("heading", { name: 'Run "Files" on this machine?' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Allow on this device" }),
    );
    expect(await first).toBe(true);

    expect(
      screen.getByRole("heading", { name: 'Run "Search" on this machine?' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Environment variables/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await second).toBe(false);
    expect(screen.queryByTestId("stdio-command-approval-dialog")).toBeNull();
  });
});

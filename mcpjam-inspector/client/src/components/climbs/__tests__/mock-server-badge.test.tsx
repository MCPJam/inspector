import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const flag = vi.hoisted(() => ({ on: true }));
const servers = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../use-climbs-enabled", () => ({ useClimbsEnabled: () => flag.on }));
vi.mock("../use-mock-servers", () => ({
  useMockServers: (_p: unknown, enabled: boolean) => ({
    mocks: new Map(enabled ? (servers.list as [string, { id: string }][]) : []),
    real: [],
    loading: false,
  }),
}));
vi.mock("../mock-sheet", () => ({ MockSheet: ({ open, mockId }: { open: boolean; mockId?: string }) => (open ? <div>sheet {mockId}</div> : null) }));
vi.mock("@/state/app-state-context", () => ({ useSharedAppState: () => ({ projects: {}, activeProjectId: "" }) }));

import { MockServerBadge } from "../mock-server-badge";

beforeEach(() => {
  flag.on = true;
  servers.list = [["mcpjam-mcp climb", { id: "m1" }]];
});

describe("MockServerBadge", () => {
  it("marks a mock server's row, and opens its sheet without opening the row", async () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <MockServerBadge projectId="proj_1" serverName="mcpjam-mcp climb" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open the mock server" }));
    expect(screen.getByText("sheet m1")).toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });
  it("shows nothing on a server that is not a mock", () => {
    const { container } = render(<MockServerBadge projectId="proj_1" serverName="stateless" />);
    expect(container).toBeEmptyDOMElement();
  });
  it("shows nothing with the flag off", () => {
    flag.on = false;
    const { container } = render(<MockServerBadge projectId="proj_1" serverName="mcpjam-mcp climb" />);
    expect(container).toBeEmptyDOMElement();
  });
});

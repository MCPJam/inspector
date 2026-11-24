import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const readMockSheet = vi.fn();
// A plain function for the failing case: the runner counts a spy's rejected copy as unhandled.
let refusal: Error | undefined;
vi.mock("@/lib/apis/climbs-api", () => ({
  readMockSheet: async (...a: unknown[]) => {
    const answer = readMockSheet(...a);
    if (refusal) throw refusal;
    return answer;
  },
}));

import { MockSheet } from "../mock-sheet";

const mock = (over: object = {}) => ({
  id: "m1",
  address: "https://app.test/api/web/mock-mcp/m1",
  version: 3,
  headVersion: 3,
  realServer: { status: "read", tools: [] },
  changes: [
    { target: "tool", name: "list_projects", kind: "changed", summary: 'Changed the description of "list_projects"', details: [{ path: "description", kind: "changed", before: "List projects.", after: "Lists the projects you can open.", summary: "Changed the description" }] },
  ],
  ...over,
});

const show = () => render(<MockSheet projectId="p" mockId="m1" name="mcpjam-mcp climb" open onOpenChange={vi.fn()} />);

beforeEach(() => {
  readMockSheet.mockReset();
  refusal = undefined;
});

describe("MockSheet", () => {
  it("shows the address with a copy button, and each edit with its before and after", async () => {
    readMockSheet.mockResolvedValue(mock());
    show();
    expect(await screen.findByDisplayValue("https://app.test/api/web/mock-mcp/m1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    expect(screen.getByText("Mock")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /list_projects/ }));
    expect(screen.getByText("Lists the projects you can open.")).toBeInTheDocument();
    // Reads the head, then what changed since the first version.
    expect(readMockSheet).toHaveBeenLastCalledWith({ projectId: "p", mockId: "m1", sinceVersion: 1 }, expect.anything());
  });
  it("says a mock with no edits answers as the real server does, and when it has no public address", async () => {
    readMockSheet.mockResolvedValue(mock({ headVersion: 1, version: 1, changes: undefined, address: null }));
    show();
    expect(await screen.findByText(/answers exactly as the real server does/)).toBeInTheDocument();
    expect(screen.getByText(/no public address for mock servers/)).toBeInTheDocument();
  });
  it("says when the real server could not be read", async () => {
    readMockSheet.mockResolvedValue(mock({ realServer: { status: "unreachable", message: "The real server did not answer.", tools: [] } }));
    show();
    expect(await screen.findByText("The real server did not answer.")).toBeInTheDocument();
  });
  it("says why it did not load", async () => {
    refusal = new Error("This mock does not exist.");
    show();
    expect(await screen.findByText("The mock server did not load")).toBeInTheDocument();
  });
  it("reads nothing while closed", () => {
    render(<MockSheet projectId="p" mockId="m1" name="x" open={false} onOpenChange={vi.fn()} />);
    expect(readMockSheet).not.toHaveBeenCalled();
  });
});

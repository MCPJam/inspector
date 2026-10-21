import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { ResourcesTab } from "../ResourcesTab";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  claimReplay: vi.fn(),
  clearReplay: vi.fn(),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  listResources: async () => ({
    resources: [{ uri: "file:///alpha.txt", name: "Alpha" }],
  }),
  readResource: (...args: unknown[]) => mocks.read(...args),
}));
vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: async () => [],
}));
vi.mock("@/lib/scope-step-up-replay", () => ({
  claimPendingDirectScopeStepUpReplay: (...args: unknown[]) =>
    mocks.claimReplay(...args),
  clearPendingDirectScopeStepUpReplay: () => mocks.clearReplay(),
  savePendingDirectScopeStepUpReplay: vi.fn(),
}));
vi.mock("../logger-view", () => ({ LoggerView: () => <div /> }));
vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

const config: MCPServerConfig = {
  transportType: "stdio",
  command: "node",
  args: [],
};
const content = (text: string) => ({
  content: { contents: [{ type: "text", text }] },
});
function pendingRead() {
  let resolve!: (value: ReturnType<typeof content>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReturnType<typeof content>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function mount(replay: boolean) {
  if (replay) {
    mocks.claimReplay.mockReturnValueOnce({
      descriptor: {
        kind: "resource",
        target: "resource",
        serverName: "srv",
        uri: "file:///alpha.txt",
      },
    });
  }
  render(<ResourcesTab serverConfig={config} serverName="srv" />);
  await screen.findByText("Alpha");
  if (!replay) fireEvent.click(screen.getByText("Alpha"));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
}
function leave(via: "back" | "subtab") {
  if (via === "back")
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
  else {
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }));
    fireEvent.click(screen.getByRole("button", { name: /^Templates/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Resources/ }));
  }
}

beforeEach(() => vi.resetAllMocks());
describe("Resources mobile read cancellation", () => {
  for (const replay of [false, true]) {
    for (const via of ["back", "subtab"] as const) {
      for (const outcome of ["success", "error"] as const) {
        it(`ignores ${replay ? "authorization replay" : "direct read"} ${outcome} after ${via}`, async () => {
          const read = pendingRead();
          mocks.read.mockReturnValueOnce(read.promise);
          await mount(replay);
          leave(via);
          await act(async () => {
            if (outcome === "success") read.resolve(content("STALE RESOURCE"));
            else read.reject(new Error("STALE FAILURE"));
          });
          fireEvent.click(screen.getByRole("tab", { name: "Results" }));
          expect(screen.queryByText("STALE RESOURCE")).not.toBeInTheDocument();
          expect(screen.queryByText(/STALE FAILURE/)).not.toBeInTheDocument();
          expect(
            screen.queryByText("Loading resource..."),
          ).not.toBeInTheDocument();
        });
      }
    }
  }
  for (const replay of [false, true]) {
    it(`renders a current ${replay ? "replay" : "direct read"} response`, async () => {
      const read = pendingRead();
      mocks.read.mockReturnValueOnce(read.promise);
      await mount(replay);
      await act(async () => read.resolve(content("CURRENT RESOURCE")));
      fireEvent.click(screen.getByRole("tab", { name: "Results" }));
      expect(screen.getByText("CURRENT RESOURCE")).toBeVisible();
      if (replay) expect(mocks.clearReplay).toHaveBeenCalledOnce();
    });
  }
  it("does not stop a newer read when a canceled replay settles", async () => {
    const old = pendingRead();
    const current = pendingRead();
    mocks.read
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await mount(true);
    leave("back");
    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve(content("STALE RESOURCE")));
    expect(screen.getByText("Loading resource...")).toBeVisible();
    await act(async () => current.resolve(content("CURRENT RESOURCE")));
    expect(screen.getByText("CURRENT RESOURCE")).toBeVisible();
  });
});

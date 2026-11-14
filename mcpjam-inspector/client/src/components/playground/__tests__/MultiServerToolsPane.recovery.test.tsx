import type { AggregatedToolsState } from "@/hooks/use-aggregated-tools";
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MultiServerToolsPaneInner } from "../panes/MultiServerToolsPane";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

const mocks = vi.hoisted(() => ({
  flat: [] as AggregatedToolsState["flat"],
  execute: vi.fn(),
}));
vi.mock("@/hooks/use-aggregated-tools", () => ({
  useAggregatedTools: () => ({
    flat: mocks.flat,
    collidingNames: [],
    loadingByServer: {},
    refetch: vi.fn(),
  }),
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({ executeTool: mocks.execute }),
}));
vi.mock("@/components/auth-challenge/PlaygroundAuthChallengeCards", () => ({
  PlaygroundAuthChallengeCards: () => null,
}));
vi.mock("@/components/playground/use-builtin-tool-run", () => ({
  useBuiltinToolRun: () => ({ selected: null, clear: vi.fn() }),
}));
vi.mock("@/components/playground/use-browser-tool-run", () => ({
  useBrowserToolRun: () => ({ selected: null, clear: vi.fn() }),
}));
vi.mock("@/components/ui/tool-details-accordion", () => ({
  ToolDetailsAccordion: () => null,
}));
vi.mock("@/components/ui-playground/ParametersForm", () => ({
  ParametersForm: () => null,
}));

beforeEach(() => {
  useUIPlaygroundStore.getState().reset();
  mocks.flat = [];
  mocks.execute.mockReset();
});
it("restores the exact server and inputs when its tools arrive, retaining them after refresh", () => {
  const servers = ["other", "bench"];
  const view = render(
    <MultiServerToolsPaneInner activeServerNames={servers} />,
  );
  act(() =>
    useUIPlaygroundStore.setState({
      recoveredToolCall: {
        serverName: "bench",
        toolName: "write",
        parameters: { value: "saved" },
      },
    }),
  );
  const entry = (serverId: string): AggregatedToolsState["flat"][number] => ({
    serverId,
    toolName: "write",
    tool: {
      name: "write",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  });
  mocks.flat = [entry("other")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  mocks.flat = [entry("other"), entry("bench")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeEnabled();
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
  mocks.flat = [entry("bench"), entry("other")];
  view.rerender(<MultiServerToolsPaneInner activeServerNames={servers} />);
  fireEvent.click(screen.getByTitle("Refresh tools"));
  expect(
    screen.getByRole("button", { name: "Run", exact: true }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Run", exact: true }));
  expect(mocks.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      serverName: "bench",
      toolName: "write",
      formFields: expect.arrayContaining([
        expect.objectContaining({ name: "value", value: "saved" }),
      ]),
    }),
  );
});

it("discards recovered inputs when their server is disabled", () => {
  useUIPlaygroundStore.setState({
    recoveredToolCall: {
      serverName: "bench",
      toolName: "write",
      parameters: { value: "old" },
    },
  });
  const view = render(<MultiServerToolsPaneInner activeServerNames={[]} />);
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
  view.rerender(<MultiServerToolsPaneInner activeServerNames={["bench"]} />);
  expect(useUIPlaygroundStore.getState().recoveredToolCall).toBeNull();
});

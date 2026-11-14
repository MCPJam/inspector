import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { DynamicToolUIPart } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";
import {
  RunAccountsProvider,
  TraceToolCallAccounts,
} from "../run-accounts-context";
import { ToolPart } from "@/components/chat-v2/thread/parts/tool-part";
import type { EvalRunAccount } from "../types";

const state = vi.hoisted(() => ({ flag: true }));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-account-selection-enabled" ? state.flag : false,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: <T,>(select: (store: { themeMode: string }) => T) =>
    select({ themeMode: "light" }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
  ScrollableJsonView: () => <div data-testid="json-editor" />,
}));

const accounts: EvalRunAccount[] = [
  {
    serverId: "srv-asana",
    kind: "account",
    connectionId: "conn-live",
    name: "Live",
  },
  {
    serverId: "srv-asana",
    kind: "account",
    connectionId: "conn-dummy",
    name: "Dummy",
  },
  {
    serverId: "srv-linear",
    kind: "account",
    connectionId: "conn-work",
    name: "Work",
  },
];

const spans: EvalTraceSpan[] = [
  {
    id: "tool-a",
    name: "asana_get_task",
    category: "tool",
    toolCallId: "call-a",
    toolName: "asana_get_task",
    serverId: "srv-asana",
    connectionId: "conn-dummy",
    startMs: 0,
    endMs: 10,
  },
  {
    // Recorded without a connection id, on a server the run had one account for.
    id: "tool-b",
    name: "linear_list_issues",
    category: "tool",
    toolCallId: "call-b",
    toolName: "linear_list_issues",
    serverId: "srv-linear",
    startMs: 10,
    endMs: 20,
  },
];

function toolRow(toolName: string) {
  const row = screen
    .getAllByTestId("trace-row")
    .find((candidate) => candidate.textContent?.includes(toolName));
  if (!row) throw new Error(`no trace row for ${toolName}`);
  return row;
}

function rowAccount(toolName: string) {
  return within(toolRow(toolName)).queryByTestId("tool-call-account")
    ?.textContent;
}

function toolCall(toolCallId: string, toolName: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state: "output-available",
    input: {},
    output: {},
  };
}

beforeEach(() => {
  state.flag = true;
});

describe("account labels in a run's trace", () => {
  it("names the account on each tool row, by connection id or the server's only account", () => {
    render(
      <RunAccountsProvider accounts={accounts}>
        <TraceTimeline recordedSpans={spans} />
      </RunAccountsProvider>,
    );
    expect(rowAccount("asana_get_task")).toBe("Dummy");
    expect(rowAccount("linear_list_issues")).toBe("Work");
    // The selected row's details carry it in the title too.
    fireEvent.click(toolRow("asana_get_task"));
    expect(
      within(screen.getByTestId("trace-detail-pane")).getByText(
        "Tool · asana_get_task · Dummy",
      ),
    ).toBeInTheDocument();
  });

  it("leaves a row unlabelled when the run recorded no accounts or the flag is off", () => {
    const { unmount } = render(<TraceTimeline recordedSpans={spans} />);
    expect(rowAccount("asana_get_task")).toBeUndefined();
    unmount();
    state.flag = false;
    render(
      <RunAccountsProvider accounts={accounts}>
        <TraceTimeline recordedSpans={spans} />
      </RunAccountsProvider>,
    );
    expect(rowAccount("asana_get_task")).toBeUndefined();
  });

  it("tags each tool card in the transcript with its account", () => {
    render(
      <RunAccountsProvider accounts={accounts}>
        <TraceToolCallAccounts spans={spans}>
          <ToolPart part={toolCall("call-a", "asana_get_task")} />
          <ToolPart part={toolCall("call-b", "linear_list_issues")} />
          <ToolPart part={toolCall("call-unknown", "asana_search")} />
        </TraceToolCallAccounts>
      </RunAccountsProvider>,
    );
    expect(
      screen.getAllByTestId("tool-call-account").map((tag) => tag.textContent),
    ).toEqual(["Dummy", "Work"]);
    expect(screen.getAllByTestId("tool-call-account")[0]).toHaveAttribute(
      "title",
      "Ran with the Dummy account",
    );
  });
});

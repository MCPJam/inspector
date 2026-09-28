import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useComparisonBrowser } from "../use-comparison-browser";
import {
  useBrowserComparisonStore as comparison,
  type BrowserComparisonClient,
} from "@/stores/browser-comparison-store";
import { useBrowserWorkspaceStore as workspace } from "@/stores/browser-workspace-store";

const client: BrowserComparisonClient = {
  workspaceId: "parent",
  projectId: "project",
  sessionId: "child",
  clientId: "cursor",
  name: "Cursor",
  order: 0,
  clientCount: 2,
  engine: "local",
};
beforeEach(() => {
  comparison.setState({ clients: {}, selected: {} });
  workspace.setState({
    conversations: {},
    revealSeq: 0,
    revealConversationId: null,
  });
});
it("registers the actual session and observes live tool calls even without rendering Chat", () => {
  const messages = [
    {
      parts: [
        {
          type: "tool-browser_navigate",
          toolCallId: "navigate",
          state: "input-available",
        },
      ],
    },
  ];
  const view = renderHook(() => useComparisonBrowser(client, messages));
  expect(comparison.getState().clients.child).toMatchObject({
    name: "Cursor",
    started: true,
  });
  expect(workspace.getState().revealConversationId).toBe("parent");
  act(() => workspace.getState().closeBrowser("parent"));
  view.rerender();
  expect(workspace.getState().conversations.parent.open).toBe(false);
  view.unmount();
  expect(comparison.getState().clients).toEqual({});
});
it("does not reopen browsers from history or unrelated tools", () => {
  renderHook(() =>
    useComparisonBrowser(client, [
      {
        parts: [
          {
            type: "tool-browser_navigate",
            toolCallId: "old",
            state: "output-available",
          },
          {
            type: "tool-browser_something",
            toolCallId: "other",
            state: "input-available",
          },
        ],
      },
    ]),
  );
  expect(workspace.getState().revealSeq).toBe(0);
  expect(comparison.getState().clients.child.started).toBe(false);
});
it("replaces registrations after a conversation reset", () => {
  const view = renderHook(
    ({ id }) => useComparisonBrowser({ ...client, sessionId: id }, []),
    { initialProps: { id: "child" } },
  );
  view.rerender({ id: "replacement" });
  expect(Object.keys(comparison.getState().clients)).toEqual(["replacement"]);
});

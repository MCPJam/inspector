import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import {
  railShouldOpenForBrowse,
  useOpenBrowserOnBrowsing,
} from "../useOpenBrowserOnBrowsing";

beforeEach(() => useBrowserWorkspaceStore.setState({ conversations: {} }));

it("opens the tool call's conversation without opening another chat", () => {
  useBrowserWorkspaceStore.getState().openBrowser("a");
  useBrowserWorkspaceStore.getState().closeBrowser("a");
  renderHook(() =>
    useOpenBrowserOnBrowsing({
      conversationId: "b",
      toolName: "browser_navigate",
      state: "input-available",
    }),
  );
  expect(useBrowserWorkspaceStore.getState().conversations).toMatchObject({
    a: { open: false },
    b: { open: true },
  });
});

it("does not open a pane for history or an ownerless tool call", () => {
  renderHook(() =>
    useOpenBrowserOnBrowsing({
      conversationId: "history",
      toolName: "browser_navigate",
      state: "output-available",
    }),
  );
  renderHook(() =>
    useOpenBrowserOnBrowsing({
      toolName: "browser_navigate",
      state: "input-available",
    }),
  );
  expect(useBrowserWorkspaceStore.getState().conversations).toEqual({});
});

it("opens the collapsed rail when the workspace panel is not the surface", () => {
  expect(
    railShouldOpenForBrowse({
      conversationId: "chat-1",
      revealConversationId: "chat-1",
      workspacePanelVisible: false,
    }),
  ).toBe(true);
  expect(
    railShouldOpenForBrowse({
      conversationId: "chat-1",
      revealConversationId: "chat-1",
      workspacePanelVisible: true,
    }),
  ).toBe(false);
  expect(
    railShouldOpenForBrowse({
      conversationId: "chat-1",
      revealConversationId: "other",
      workspacePanelVisible: false,
    }),
  ).toBe(false);
});

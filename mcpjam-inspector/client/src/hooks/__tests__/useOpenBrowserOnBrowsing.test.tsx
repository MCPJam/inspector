import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import {
  isBrowserToolName,
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

it("opens for every browser tool the server builds, page tools included", () => {
  for (const name of [
    "browser_navigate",
    "browser_act",
    "browser_observe",
    "browser_tabs",
    "browser_webmcp_tools",
    "browser_webmcp_invoke",
    "webmcp_add_to_cart",
  ])
    expect(isBrowserToolName(name)).toBe(true);
  for (const name of [
    undefined,
    "browser_thing",
    "browser_page_tool",
    "webmcp_",
    "search_docs",
  ])
    expect(isBrowserToolName(name)).toBe(false);
});

it("opens the pane when the model calls a page tool", () => {
  renderHook(() =>
    useOpenBrowserOnBrowsing({
      conversationId: "c",
      toolName: "webmcp_add_to_cart",
      state: "input-streaming",
    }),
  );
  expect(useBrowserWorkspaceStore.getState().conversations).toMatchObject({
    c: { open: true },
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

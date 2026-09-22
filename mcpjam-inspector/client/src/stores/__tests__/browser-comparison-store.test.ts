import { beforeEach, describe, expect, it } from "vitest";
import {
  useBrowserComparisonStore as comparison,
  type BrowserComparisonClient,
} from "../browser-comparison-store";
import { useBrowserWorkspaceStore as workspace } from "../browser-workspace-store";

const client = (sessionId: string, order = 0): BrowserComparisonClient => ({
  workspaceId: "workspace",
  projectId: "project",
  sessionId,
  clientId: sessionId,
  name: sessionId,
  order,
  clientCount: 2,
  engine: "local",
});
beforeEach(() => {
  comparison.setState({ clients: {}, selected: {} });
  workspace.setState({
    conversations: {},
    revealSeq: 0,
    revealConversationId: null,
  });
});

describe("comparison browser ownership", () => {
  it("opens the parent workspace for the first browsing child and never steals selection", () => {
    comparison.getState().register(client("cursor"));
    comparison.getState().register(client("mcpjam", 1));
    workspace.getState().openBrowser("mcpjam");
    workspace.getState().openBrowser("cursor");
    expect(comparison.getState().selected.workspace).toBe("mcpjam");
    expect(workspace.getState().conversations).toEqual({
      workspace: { open: true, expanded: false },
    });
    expect(workspace.getState().revealConversationId).toBe("workspace");
    comparison.getState().select("workspace", "cursor");
    workspace.getState().openBrowser("mcpjam");
    expect(comparison.getState().selected.workspace).toBe("cursor");
  });

  it("preserves activity on label updates and falls back in lineup order on removal", () => {
    for (const [id, order] of [
      ["a", 2],
      ["b", 1],
      ["c", 0],
    ] as const) {
      comparison.getState().register(client(id, order));
      comparison.getState().noteBrowsing(id);
    }
    comparison.getState().register({ ...client("a", 2), name: "Renamed" });
    expect(comparison.getState().clients.a.started).toBe(true);
    comparison.getState().unregister("a", "workspace");
    expect(comparison.getState().selected.workspace).toBe("c");
    comparison.getState().unregister("b", "workspace");
    comparison.getState().unregister("c", "workspace");
    expect(comparison.getState().clients).toEqual({});
    expect(comparison.getState().selected).toEqual({});
  });

  it("does not route a normal conversation or select/remove another workspace's session", () => {
    comparison.getState().register(client("a"));
    comparison.getState().select("other", "a");
    comparison.getState().unregister("a", "other");
    expect(comparison.getState().selected).toEqual({});
    expect(comparison.getState().clients.a).toBeDefined();
    workspace.getState().openBrowser("ordinary");
    expect(workspace.getState().revealConversationId).toBe("ordinary");
  });
});

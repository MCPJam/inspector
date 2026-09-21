import { useEffect } from "react";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";

/**
 * The browser's model-facing tools.
 *
 * Listed rather than matched on a `browser_` prefix, because the prefix is not
 * a namespace anybody owns: an MCP server is free to publish a tool called
 * `browser_thing`, and a panel that opened because a third-party server ran
 * one would be taking 60% of somebody's workspace on a coincidence. These are
 * the six the harness registers (`server/utils/built-in-tools/browser.ts`);
 * one that is added there and not here simply does not open the panel, which
 * is the failure that goes unnoticed rather than the one that annoys people.
 */
const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_act",
  "browser_observe",
  "browser_tabs",
  "browser_page_tool",
  "browser_cancel_page_tool",
]);

export function isBrowserToolName(name: string | undefined): boolean {
  return !!name && BROWSER_TOOL_NAMES.has(name);
}

/**
 * States a tool part is in while it is HAPPENING.
 *
 * The distinction that makes this hook usable at all. A thread's history is
 * full of browser tool calls, and every one of them re-renders when somebody
 * scrolls back — so a hook that fired on "this part is a browser tool" would
 * open the panel because a person read their own transcript. A part that has
 * not produced output yet is live work; a part with output is a record of
 * work that already happened.
 */
const LIVE_STATES: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
]);

/**
 * Open the browser panel when the agent starts browsing.
 *
 * Called from the tool-call card, which is the one place in the client that
 * already knows a browser tool is running. The alternatives were both worse: a
 * poll against "is a browser session alive" costs a Convex action every few
 * seconds on the hosted engine and cannot distinguish a session the agent just
 * opened from one left over from ten minutes ago, and a signal from the
 * browser body itself is circular — the body only mounts once the panel is
 * open.
 *
 * `openBrowser` is idempotent, so this deliberately does not track whether it
 * has fired: a person who closed the panel and let the agent keep browsing
 * gets it back on the next tool call, which is what "open it when browsing
 * starts" means when browsing never stopped.
 */
/**
 * The right rail starts collapsed ("Show logs"). Switching its Browser tab
 * does nothing until the rail itself is on screen. When the workspace flag
 * owns the browser, leave the rail alone — that surface is a panel beside
 * chat, not this tab.
 */
export function railShouldOpenForBrowse(args: {
  conversationId: string | null;
  revealConversationId: string | null;
  workspacePanelVisible: boolean;
}): boolean {
  return (
    !!args.conversationId &&
    args.revealConversationId === args.conversationId &&
    !args.workspacePanelVisible
  );
}

export function useOpenBrowserOnBrowsing(args: {
  conversationId?: string;
  toolName: string | undefined;
  state: string | undefined;
}): void {
  const openBrowser = useBrowserWorkspaceStore((store) => store.openBrowser);
  const live =
    isBrowserToolName(args.toolName) && LIVE_STATES.has(args.state ?? "");
  useEffect(() => {
    if (live && args.conversationId) openBrowser(args.conversationId);
  }, [live, args.conversationId, openBrowser]);
}

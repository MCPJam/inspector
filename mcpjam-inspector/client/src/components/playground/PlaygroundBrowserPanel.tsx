import { BrowserRuntimeControls } from "@/components/browser/BrowserRuntimeControls";
import { useCallback, useEffect } from "react";
import { Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import { LocalBrowserBody } from "@/components/browser/LocalBrowserBody";
import { HostedBrowserBody } from "@/components/browser/HostedBrowserBody";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { useMintConversationBrowserToken } from "@/hooks/useProjectComputer";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import { useBrowserComparisonStore } from "@/stores/browser-comparison-store";
import { ComparisonBrowser } from "@/components/browser/ComparisonBrowser";

/**
 * The browser, beside chat.
 *
 * It used to be the third tab of the right rail, in a 30%-wide column, behind
 * Logs. Three things were wrong with that and only one of them was the width.
 * A page rendered at 30% of a workspace is a page in its mobile layout, so an
 * agent testing a desktop app was testing the phone version of it. Switching
 * to the logs hid the browser, which is the moment you most want to see what
 * the agent just did. And the browser's visibility was decided by a rail whose
 * other two tabs are text.
 *
 * So it is its own panel now, and the rail keeps Logs and Shell. What did NOT
 * move is the engine choice: which body goes here still follows the project's
 * selected computer engine, exactly as the rail's tab did, so a person who
 * picked "This machine" sees the local body whether or not they have
 * authorized it yet.
 */

export interface PlaygroundBrowserPanelProps {
  projectId: string | null;
  /**
   * Is the panel on screen?
   *
   * The panel stays MOUNTED behind an expanded chat or a collapsed divider —
   * dropping the socket would stop the screencast and lose whatever the agent
   * was mid-way through — so this is what tells the bodies to stop CLAIMING:
   * the watch that defers the idle reap, and the measurement that drives the
   * session viewport. On the hosted engine that claim keeps a metered box
   * awake.
   */
  visible: boolean;
  onClose: () => void;
}

export function PlaygroundBrowserPanel({
  projectId,
  visible,
  onClose,
}: PlaygroundBrowserPanelProps) {
  const engine = useBrowserEngine(projectId);
  // THE DURABLE SESSION, in the panel as well as in the rail tab it replaces.
  // The browser a chat owns keeps its logins and its saved profile across
  // turns, and that identity travels on the token: minting the project-scoped
  // one here would hand the workspace a fresh anonymous browser every time,
  // which is every time this panel is the browser.
  // @see PlaygroundRightRail, which wires the fallback tab identically.
  const mintConversationBrowserToken = useMintConversationBrowserToken();
  const activeChatSessionId = useActiveChatSessionStore(
    (state) => state.sessionId,
  );
  const browserSessionId = activeChatSessionId ?? undefined;
  const hasComparison = useBrowserComparisonStore((state) =>
    Object.values(state.clients).some(
      (client) =>
        client.workspaceId === browserSessionId &&
        client.projectId === projectId,
    ),
  );
  const mintHostedBrowserToken = useCallback(
    ({ projectId: tokenProjectId }: { projectId: string }) => {
      if (!browserSessionId)
        throw new Error("The conversation is still loading.");
      return mintConversationBrowserToken({
        projectId: tokenProjectId,
        conversationId: browserSessionId,
      });
    },
    [browserSessionId, mintConversationBrowserToken],
  );
  const expanded = useBrowserWorkspaceStore((state) =>
    browserSessionId
      ? !!state.conversations[browserSessionId]?.expanded
      : false,
  );
  const setConversationExpanded = useBrowserWorkspaceStore(
    (state) => state.setExpanded,
  );
  const setExpanded = useCallback(
    (value: boolean) => {
      if (browserSessionId) setConversationExpanded(browserSessionId, value);
    },
    [browserSessionId, setConversationExpanded],
  );

  // An expanded browser that is no longer on screen has nothing to be expanded
  // over. Left set, it would take over the window the next time the panel
  // opened, with the control to undo it in the corner of a panel nobody
  // expected to see.
  useEffect(() => {
    if (!visible && expanded) setExpanded(false);
  }, [visible, expanded, setExpanded]);

  // The BODY follows `selectedEngine` (consent-blind), mirroring the Computer
  // tab and the rail's Shell: somebody who picked "This machine" but has not
  // authorized it yet must see the local body's pointer, not a cloud browser
  // they did not ask for.
  const isLocal = engine.selectedEngine === "local";

  if (!browserSessionId)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading conversation…
      </p>
    );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid="playground-browser-panel"
    >
      <div className="flex shrink-0 items-center justify-end gap-0.5 border-b border-border px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Restore browser" : "Expand browser"}
          aria-pressed={expanded}
          title={expanded ? "Restore browser" : "Expand browser"}
          data-testid="browser-expand"
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-colors",
            "hover:bg-accent/60 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {expanded ? (
            <Minimize2 className="size-3.5" aria-hidden />
          ) : (
            <Maximize2 className="size-3.5" aria-hidden />
          )}
        </button>
        <BrowserRuntimeControls projectId={projectId} compact />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close browser panel"
          title="Close browser panel"
          data-testid="browser-panel-close"
          className={cn(
            "rounded-md p-1 text-muted-foreground transition-colors",
            "hover:bg-accent/60 hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <PanelRightClose className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {hasComparison && projectId ? (
          <ComparisonBrowser
            key={`${projectId}:${browserSessionId}`}
            projectId={projectId}
            workspaceId={browserSessionId}
            active={visible}
          />
        ) : isLocal && !engine.localAvailable ? (
          <p className="p-4 text-sm text-muted-foreground">
            Browser is unavailable on this machine. Check Browser settings or
            choose Cloud for a new chat.
          </p>
        ) : isLocal ? (
          <LocalBrowserBody
            key={`${projectId}:${browserSessionId}:local`}
            projectId={projectId}
            sessionId={browserSessionId}
            consentGranted={engine.consent.granted}
            consentToken={engine.consent.token}
            active={visible}
          />
        ) : (
          <HostedBrowserBody
            key={`${projectId}:${browserSessionId}:hosted`}
            projectId={projectId}
            sessionId={browserSessionId}
            mintToken={mintHostedBrowserToken}
            active={visible}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Should the Playground offer a browser panel at all?
 *
 * The same question the rail's Browser tab already answered, kept in one place
 * now that two components ask it. A host without the `browser` built-in has no
 * browser for the model to drive, so a panel would be a promise the host
 * config does not keep — except that an outside agent can open one through
 * `mcpjam browser open` without the host carrying the built-in at all, and
 * hiding the panel then would mean the browser somebody is driving is visible
 * in no window in this app.
 *
 * The hosted body additionally needs a signed-in user: every one of its calls
 * carries a minted browser token, so before authentication is ready it can
 * only fail — into an "unreachable" state with nothing to retry it once auth
 * arrives.
 */
export function browserPanelAvailable(args: {
  hostHasBrowser: boolean;
  sessionHasBrowser?: boolean;
  selectedEngine: "local" | "cloud";
  isAuthenticated: boolean;
  localBrowserRunning: boolean;
}): boolean {
  if (args.sessionHasBrowser && args.isAuthenticated) return true;
  if (args.localBrowserRunning) return true;
  // Local users must be able to open the explicit setup prompt before any
  // client has Browser attached. Callers already enforce the rollout gate.
  if (args.selectedEngine === "local") return true;
  if (!args.hostHasBrowser) return false;
  return args.isAuthenticated;
}

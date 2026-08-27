import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { ToolsPanel } from "./ToolsPanel";
import { ToolInvokePane } from "./ToolInvokePane";
import { ActivityTimeline } from "./ActivityTimeline";
import type {
  WebMcpActivityEntry,
  WebMcpSessionStatus,
} from "@/shared/webmcp-inspector-protocol";

/**
 * The WebMCP workspace: a URL bar, the live tool registry, one tool's schema
 * and invoke form, and the activity timeline.
 *
 * There is no embedded viewport, and that is the design rather than a gap. The
 * browser opens as a real window on this machine, so the developer drives their
 * own page with their own devtools open; this screen is the instrument panel
 * beside it. A streamed viewport is what the hosted stage needs, and the
 * session already reports which transport it is on so this screen can render
 * one when a provider offers it.
 */
export function WebmcpInspectorTab() {
  const {
    session,
    tools,
    activity,
    pending,
    starting,
    error,
    lastScreenshot,
    startSession,
    closeSession,
    sendCommand,
    invokeTool,
    cancelInvocation,
    captureScreenshot,
    clearError,
    reconnect,
    disconnect,
  } = useWebmcpInspectorStore();

  const [url, setUrl] = useState("http://localhost:3000");
  const [selectedToolKey, setSelectedToolKey] = useState<string | undefined>();
  const [rightTab, setRightTab] = useState<"tools" | "activity">("tools");

  // The browser outlives this screen on purpose — a developer may tab away
  // mid-flow — so unmounting closes the event stream and nothing else. Coming
  // back re-attaches to the session still running: without this, the header
  // would still say a browser is open while no tool registration or invocation
  // result could ever arrive, and an invoke would appear to hang forever.
  useEffect(() => {
    reconnect();
    return () => disconnect();
  }, [reconnect, disconnect]);

  const selectedTool = tools.find((tool) => tool.toolKey === selectedToolKey);
  const pendingForSelected = pending.find(
    (item) => item.toolKey === selectedToolKey,
  );
  const lastResultForSelected = [...activity]
    .reverse()
    .find(
      (
        entry,
      ): entry is Extract<
        WebMcpActivityEntry,
        { kind: "invocation_settled" }
      > =>
        entry.kind === "invocation_settled" &&
        entry.toolKey === selectedToolKey,
    );

  const live = Boolean(session) && session?.status !== "closed";

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            void (live
              ? sendCommand({ type: "navigate", url })
              : startSession(url));
          }}
          placeholder="http://localhost:3000"
          className="max-w-md font-mono text-sm"
          spellCheck={false}
          // The placeholder never shows — `url` starts populated — so without
          // this the field has no accessible name at all.
          aria-label="Page URL to inspect"
        />
        {live ? (
          <>
            <Button
              size="sm"
              onClick={() => void sendCommand({ type: "navigate", url })}
            >
              Go
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void sendCommand({ type: "reload" })}
            >
              Reload
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void captureScreenshot()}
            >
              Screenshot
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void closeSession()}
            >
              Close browser
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => void startSession(url)}
            disabled={starting}
          >
            {starting ? "Opening…" : "Open browser"}
          </Button>
        )}
        {session ? <StatusBadge status={session.status} /> : null}
      </header>

      {error ? (
        <ErrorBanner
          message={error.message}
          code={error.code}
          onDismiss={clearError}
        />
      ) : null}

      {live ? (
        <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          {/* Never promise a window that does not exist: a headless session
              has no viewport to point anyone at. */}
          {session?.viewportTransport.kind === "headless"
            ? "Running headless — no window to interact with. Tools, invocation and screenshots all work; use the Screenshot button to see the page."
            : "A browser window is open on this machine — interact with the page there. Tools it registers appear here as they register."}
          {session?.url ? (
            <span className="ml-1 font-mono">{session.url}</span>
          ) : null}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r">
          <ToolInvokePane
            tool={selectedTool}
            lastResult={lastResultForSelected}
            pendingInvokeId={pendingForSelected?.invokeId}
            onInvoke={(input) => {
              if (!selectedToolKey) return;
              void invokeTool(selectedToolKey, input);
            }}
            onCancel={(invokeId) => void cancelInvocation(invokeId)}
          />
          {lastScreenshot ? (
            <figure className="border-t p-3">
              <img
                src={`data:image/jpeg;base64,${lastScreenshot}`}
                alt="The inspected page"
                className="max-h-64 rounded border"
              />
              <figcaption className="pt-1 text-[11px] text-muted-foreground">
                Snapshot of the page as of the last capture.
              </figcaption>
            </figure>
          ) : null}
        </div>

        <aside className="flex w-96 min-w-80 flex-col">
          <div className="flex border-b">
            {(["tools", "activity"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRightTab(tab)}
                className={cn(
                  "flex-1 px-3 py-2 text-xs font-medium capitalize transition-colors",
                  rightTab === tab
                    ? "border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab}
                {tab === "tools" && tools.length > 0
                  ? ` (${tools.length})`
                  : ""}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {rightTab === "tools" ? (
              <ToolsPanel
                tools={tools}
                selectedToolKey={selectedToolKey}
                onSelect={setSelectedToolKey}
                hasSession={live}
              />
            ) : (
              <ActivityTimeline entries={activity} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: WebMcpSessionStatus }) {
  // Typed against the protocol union rather than `string`: if a status is
  // renamed there, this mapping should fail to compile instead of silently
  // falling through to "secondary".
  const tone: "default" | "destructive" | "secondary" =
    status === "ready"
      ? "default"
      : status === "error" || status === "unsupported"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={tone} className="text-[10px] capitalize">
      {status}
    </Badge>
  );
}

/**
 * The failure modes worth spelling out. Each one is a different thing for the
 * reader to do, so each gets its own sentence rather than a generic "error".
 */
function ErrorBanner({
  message,
  code,
  onDismiss,
}: {
  message: string;
  code?: string;
  onDismiss: () => void;
}) {
  const guidance =
    code === "webmcp-unsupported"
      ? "The page loaded, but this browser build cannot expose WebMCP tools, so there is nothing to inspect."
      : code === "no-display"
        ? "Running over SSH or in a container? Restart the inspector with MCPJAM_WEBMCP_HEADLESS=true to inspect tools without a visible window."
        : code === "chromium-not-installed"
          ? "Chromium could not be found or installed. Run `npx playwright install chromium` and try again."
          : code === "capacity"
            ? "Close an open browser session before starting another."
            : code === "session-not-found"
              ? "Open the page again to start a new session."
              : undefined;

  return (
    <div className="flex items-start gap-3 border-b bg-destructive/10 px-3 py-2 text-sm">
      <div className="flex-1">
        <p className="text-destructive">{message}</p>
        {guidance ? (
          <p className="text-xs text-muted-foreground">{guidance}</p>
        ) : null}
      </div>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

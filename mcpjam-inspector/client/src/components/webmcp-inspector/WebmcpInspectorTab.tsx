import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { useHostContextStore } from "@/stores/client-context-store";
import { ToolsPanel } from "./ToolsPanel";
import { ToolInvokePane } from "./ToolInvokePane";
import { ActivityTimeline } from "./ActivityTimeline";
import {
  buildOtlpExport,
  buildSessionExport,
  exportFilename,
} from "@/lib/webmcp-inspector/session-export";
import { WEBMCP_VIEWPORT } from "@/shared/webmcp-inspector-protocol";
import {
  createInputForwarder,
  type InputForwarder,
} from "@/lib/webmcp-inspector/input-forwarder";
import type {
  WebMcpActivityEntry,
  WebMcpFrame,
  WebMcpInputEvent,
  WebMcpSessionStatus,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";

/**
 * Cadence of the FALLBACK screenshot poll.
 *
 * Only reached when the viewport stream is unavailable: a server too old to
 * know `set_screencast`, or a hosted session whose picture comes from somewhere
 * else entirely. A second is deliberately slow — this path costs a full
 * round-trip screenshot per tick, and it exists to keep the pane honest rather
 * than to look live.
 */
const SCREENSHOT_POLL_MS = 1_000;

/**
 * The WebMCP workspace: a URL bar, the live tool registry, one tool's schema
 * and invoke form, and the activity timeline.
 *
 * There is no embedded viewport, and for the LOCAL provider that is the design
 * rather than a gap: the browser opens as a real window on this machine, so the
 * developer drives their own page with their own devtools open, and this screen
 * is the instrument panel beside it.
 *
 * The hosted provider changes where the browser is, not what this screen does.
 * Its session reports `remote-interactive-url`, and the viewport lives in the
 * Browser panel, which can both show the stream and hand control to a person.
 * So the notice at the top of this screen has to say which of those situations
 * the viewer is actually in — see `viewportNotice`. Telling someone driving a
 * datacenter browser to look at a window on their own desk sends them hunting
 * for something that is not there.
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
    liveFrame,
    startSession,
    closeSession,
    sendCommand,
    invokeTool,
    cancelInvocation,
    captureScreenshot,
    setScreencast,
    sendInput,
    clearError,
    reconnect,
    disconnect,
  } = useWebmcpInspectorStore();

  const [url, setUrl] = useState("http://localhost:3000");
  const [selectedToolKey, setSelectedToolKey] = useState<string | undefined>();
  const [rightTab, setRightTab] = useState<"tools" | "activity">("tools");
  /**
   * Opt-in, and deliberately not remembered: a hosted session reserves a
   * desktop computer and bills its awake time, so it is a choice made per
   * session rather than a preference that quietly persists.
   */
  const [hosted, setHosted] = useState(false);
  /**
   * WHERE the next session's browser appears.
   *
   * In-app by default: someone opening this screen expects to see the page they
   * are inspecting, not to go hunting for a window behind their editor. A
   * Chrome window is still one click away, and is what someone wants when they
   * need their own devtools open on the page.
   *
   * Both labels name a DESTINATION rather than a mode, because "In app" and
   * "Chrome window" are things a person can picture; "embedded" and "headless"
   * are things the implementation is called.
   */
  const [inApp, setInApp] = useState(true);
  /**
   * Whether the pane should be showing the page at all.
   *
   * On by default: seeing the page you are inspecting is the point of the
   * screen, and the stream is demand-driven precisely so that having it on by
   * default costs nothing once nobody is looking. Off is for someone who wants
   * the tool registry without a browser encoding JPEGs behind it.
   */
  const [liveView, setLiveView] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const activeProjectId = useHostContextStore((state) => state.activeProjectId);

  // The browser outlives this screen on purpose — a developer may tab away
  // mid-flow — so unmounting closes the event stream and nothing else. Coming
  // back re-attaches to the session still running: without this, the header
  // would still say a browser is open while no tool registration or invocation
  // result could ever arrive, and an invoke would appear to hang forever.
  useEffect(() => {
    reconnect();
    return () => disconnect();
  }, [reconnect, disconnect]);

  // A backgrounded tab is not watching anything. Tracked as state rather than
  // read inside the streaming effect so that becoming visible again RE-RUNS
  // that effect, which is what restarts the stream.
  useEffect(() => {
    const onChange = () =>
      setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const live = Boolean(session) && session?.status !== "closed";
  const transportKind = session?.viewportTransport.kind;
  /** The hosted browser paints somewhere else; there is no screencast to ask for. */
  const hostedViewport = transportKind === "remote-interactive-url";
  /**
   * An in-app session has no other viewport, so its stream is not optional.
   *
   * Offering "Live view: off" there would offer a browser nobody can see or
   * touch — a state with no way back except closing the session. Visibility
   * gating still applies, which covers the case the toggle was for: a tab
   * nobody is looking at stops streaming on its own.
   */
  const streamRequired = transportKind === "frame-stream";
  const streaming = live && (liveView || streamRequired) && documentVisible;

  /**
   * Keep the pane fed while it is being looked at, and stop the moment it is
   * not.
   *
   * Two sources, one pane. The viewport STREAM is the primary path — frames
   * arrive as the page paints. The screenshot POLL is the fallback, for a
   * server too old to know `set_screencast` and for a hosted session whose
   * picture comes from the Browser panel instead. The fallback engages on its
   * own, silently: someone running an older server should see their page, not
   * an error explaining why they cannot.
   */
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (cancelled || poll !== undefined) return;
      void captureScreenshot();
      poll = setInterval(() => void captureScreenshot(), SCREENSHOT_POLL_MS);
    };

    if (hostedViewport) {
      startPolling();
    } else {
      void setScreencast(true).then((accepted) => {
        if (!accepted) startPolling();
      });
    }

    return () => {
      cancelled = true;
      if (poll !== undefined) clearInterval(poll);
      // Asked for unconditionally, including when the stream was never running:
      // it is idempotent on the server, and a session left encoding frames for
      // a pane nobody is looking at is exactly what demand-driving avoids.
      if (!hostedViewport) void setScreencast(false);
    };
  }, [streaming, hostedViewport, setScreencast, captureScreenshot]);

  /**
   * Where this session's browser should run and appear.
   *
   * A hosted browser is watched and driven from the Browser panel, which has
   * its own take-control lease, so it never asks for the in-app pane — the
   * server refuses that combination and this avoids sending it at all.
   */
  const startOptions = () => {
    if (hosted && activeProjectId) {
      return { transport: "hosted" as const, projectId: activeProjectId };
    }
    return inApp ? { display: "in-app" as const } : undefined;
  };

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

  /**
   * Hand the session's evidence to the developer as a file.
   *
   * A download rather than a copy button: these run to hundreds of kilobytes
   * with screenshots, and the usual destination is a bug report or a trace
   * ingester, not a clipboard.
   */
  const exportAs = (kind: "json" | "otlp") => {
    const input = {
      session,
      tools,
      activity,
      includeScreenshots: kind === "json",
      exportedAt: Date.now(),
    };
    const payload =
      kind === "otlp" ? buildOtlpExport(input) : buildSessionExport(input);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = exportFilename(session?.sessionId, kind);
    anchor.click();
    // Deferred: Firefox starts the download on a later task, so revoking in
    // this one invalidates the URL before it is read and the file never
    // arrives — with no error to show for it.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  };

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
              : startSession(url, startOptions()));
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
            {streamRequired ? null : (
              <Button
                size="sm"
                variant={liveView ? "default" : "outline"}
                aria-pressed={liveView}
                onClick={() => setLiveView((on) => !on)}
                title={
                  liveView
                    ? "Streaming the page here. Turn it off to stop the browser encoding frames."
                    : "Not streaming. Turn it on to watch the page here."
                }
              >
                Live view
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void closeSession()}
            >
              Close browser
            </Button>
          </>
        ) : null}
        {/* Available after the browser closes too: the timeline is the point
            of the session, and it is most wanted once something went wrong. */}
        {activity.length > 0 ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => exportAs("json")}
            >
              Export JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => exportAs("otlp")}
            >
              Export OTLP
            </Button>
          </>
        ) : null}
        {!live && !hosted ? (
          <Button
            size="sm"
            variant="outline"
            aria-pressed={inApp}
            onClick={() => setInApp((on) => !on)}
            disabled={starting}
            title={
              inApp
                ? "The page runs headless and appears in this pane; click and type into it here."
                : "The page opens in a real Chrome window on this machine, with your own devtools available."
            }
          >
            {inApp ? "In app" : "Chrome window"}
          </Button>
        ) : null}
        {!live && activeProjectId ? (
          <Button
            size="sm"
            variant={hosted ? "default" : "outline"}
            aria-pressed={hosted}
            onClick={() => setHosted((on) => !on)}
            disabled={starting}
            title={
              hosted
                ? "Runs on your MCPJam computer. It cannot reach localhost, and its awake time is billed."
                : "Runs in a window on this machine."
            }
          >
            {hosted ? "On my computer" : "On this machine"}
          </Button>
        ) : null}
        {!live ? (
          <Button
            size="sm"
            onClick={() => void startSession(url, startOptions())}
            disabled={starting}
          >
            {starting ? "Opening…" : "Open browser"}
          </Button>
        ) : null}
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
          {/* Never promise a window that does not exist. A headless session has
              no viewport at all, and a HOSTED one has a browser running on a
              machine in a datacenter — telling someone to look at a window on
              their own desk would send them hunting for something that is not
              there. */}
          {viewportNotice(session?.viewportTransport.kind)}
          {session?.url ? (
            <span className="ml-1 font-mono">{session.url}</span>
          ) : null}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-auto border-r">
          {live ? (
            <ViewportPane
              frame={liveFrame}
              fallbackScreenshot={lastScreenshot}
              streaming={streaming}
              transport={session?.viewportTransport}
              onInput={sendInput}
            />
          ) : null}
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

/**
 * The page, as a picture.
 *
 * Three sources in strict order, because they degrade rather than compete: the
 * live frame if one has arrived, the last manual/polled screenshot if not, and
 * a line of text if neither. The middle rung is what makes an older server, a
 * hosted session, and the first few hundred milliseconds of a new one all show
 * something rather than a hole.
 *
 * The frame carries its own device dimensions, so the box is sized from the
 * frame rather than from a viewport constant: the two would only ever disagree
 * during a resize, and that is exactly when a stale aspect ratio would letterbox
 * the picture wrongly.
 */
function ViewportPane({
  frame,
  fallbackScreenshot,
  streaming,
  transport,
  onInput,
}: {
  frame: WebMcpFrame | undefined;
  fallbackScreenshot: string | undefined;
  streaming: boolean;
  transport: WebMcpViewportTransport | undefined;
  onInput: (events: WebMcpInputEvent[]) => void;
}) {
  const source = frame?.data ?? fallbackScreenshot;
  /**
   * Whether this pane drives the page.
   *
   * Only a `frame-stream` session. A native-window session is view-only on
   * purpose: the person already has the real page in front of them, and
   * forwarding pane input would drive it a SECOND time — every click landing
   * twice, from two directions, with nothing reconciling them.
   */
  const interactive = transport?.kind === "frame-stream";
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [focused, setFocused] = useState(false);

  /**
   * Aspect ratio, from the frame when there is one and from the transport
   * before that.
   *
   * The transport reports the surface at session start precisely so the box is
   * the right shape before the first frame: a pane that resizes a moment after
   * it appears scales any click landing in that moment against the wrong box.
   */
  const surface = frame
    ? { width: frame.deviceWidth, height: frame.deviceHeight }
    : transport?.kind === "frame-stream"
      ? { width: transport.width, height: transport.height }
      : { width: WEBMCP_VIEWPORT.width, height: WEBMCP_VIEWPORT.height };

  const frameSizeRef = useRef(surface);
  frameSizeRef.current = surface;

  const forwarder = useMemo<InputForwarder>(
    () =>
      createInputForwarder({
        send: onInput,
        geometry: () => {
          const element = imageRef.current;
          if (!element) return undefined;
          const rect = element.getBoundingClientRect();
          return { rect, frame: frameSizeRef.current };
        },
      }),
    [onInput],
  );

  useEffect(() => () => forwarder.dispose(), [forwarder]);

  // A pane that is no longer being driven must not leave keys held in the page.
  useEffect(() => {
    if (interactive) return;
    forwarder.releaseHeld();
  }, [interactive, forwarder]);

  const pointerHandlers = interactive
    ? {
        onPointerMove: (event: React.PointerEvent) =>
          forwarder.mouseMove(event.nativeEvent),
        onPointerDown: (event: React.PointerEvent) => {
          // Captured so a drag that leaves the pane still reports its motion and
          // its release here, rather than ending in whatever it passed over.
          event.currentTarget.setPointerCapture?.(event.pointerId);
          (event.currentTarget as HTMLElement).focus();
          forwarder.mouseDown(event.nativeEvent);
        },
        onPointerUp: (event: React.PointerEvent) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          forwarder.mouseUp(event.nativeEvent);
        },
        onWheel: (event: React.WheelEvent) =>
          forwarder.wheel(event.nativeEvent),
        // Suppressed rather than forwarded: a native context menu opens in the
        // browser running the page, which is headless — so the menu would exist
        // nowhere and never appear in a frame, while this browser's own menu
        // covered the pane.
        onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
        onKeyDown: (event: React.KeyboardEvent) => {
          // Only while the pane holds focus, so the app's own shortcuts keep
          // working everywhere else. Tab is forwarded rather than moving focus:
          // tabbing through a form is a thing people do to the page.
          event.preventDefault();
          forwarder.keyDown(event.nativeEvent);
        },
        onKeyUp: (event: React.KeyboardEvent) => {
          event.preventDefault();
          forwarder.keyUp(event.nativeEvent);
        },
        onPaste: (event: React.ClipboardEvent) => {
          event.preventDefault();
          forwarder.text(event.clipboardData.getData("text"));
        },
        onFocus: () => setFocused(true),
        onBlur: () => {
          setFocused(false);
          // The page never sees that focus left, so a modifier held at this
          // moment would stay held in it for the rest of the session and turn
          // every later click into a ctrl-click.
          forwarder.releaseHeld();
        },
      }
    : {};

  return (
    <figure className="m-0 border-b bg-muted/20 p-3">
      <div
        // Focusable only when it drives something: a tab stop that does nothing
        // is a trap for anyone navigating by keyboard.
        {...(interactive ? { tabIndex: 0 } : {})}
        {...pointerHandlers}
        aria-label={
          interactive ? "The inspected page — click to interact" : undefined
        }
        className={cn(
          "relative mx-auto w-full max-w-3xl overflow-hidden rounded border bg-black/80",
          interactive && "cursor-default touch-none",
          interactive && focused && "ring-2 ring-primary",
        )}
        style={{ aspectRatio: `${surface.width} / ${surface.height}` }}
      >
        {source ? (
          <img
            // Distinct from the manual-capture thumbnail's alt below: two
            // images described identically would give a screen reader no way
            // to tell the live view from a snapshot someone took.
            ref={imageRef}
            src={`data:image/jpeg;base64,${source}`}
            alt="Live view of the inspected page"
            className="pointer-events-none h-full w-full object-contain select-none"
            draggable={false}
            // Frames arrive faster than a decode; letting the browser paint the
            // previous one until this decodes is what keeps the pane from
            // flashing black between frames.
            decoding="async"
          />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {streaming
              ? "Waiting for the first frame…"
              : "Live view is off. Turn it on to watch the page here."}
          </p>
        )}
      </div>
      <figcaption className="pt-1 text-center text-[11px] text-muted-foreground">
        {transport?.kind === "remote-interactive-url"
          ? "Snapshots of your MCPJam computer's browser. Open the Browser panel to interact with it."
          : interactive
            ? focused
              ? "Typing and clicking here goes to the page."
              : "Click to interact with the page."
            : "A live view of the page. Interact with it in the browser window."}
      </figcaption>
    </figure>
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

/**
 * What to tell someone about where the browser they are driving actually is.
 * Each branch is a different physical situation, and getting it wrong sends
 * people looking for a window that does not exist.
 */
function viewportNotice(
  kind: WebMcpViewportTransport["kind"] | undefined,
): string {
  switch (kind) {
    case "headless":
      return "Running headless — no window to interact with. Tools, invocation and screenshots all work; use the Screenshot button to see the page.";
    case "remote-interactive-url":
      return "This browser is running on your MCPJam computer, not on this machine. Open the Browser panel to watch it, or to take control when a sign-in needs you.";
    case "frame-stream":
      return "This page is running in the pane below — click and type into it there. Tools it registers appear as they register.";
    default:
      return "A browser window is open on this machine — interact with the page there. Tools it registers appear here as they register.";
  }
}

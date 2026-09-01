import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { useHostContextStore } from "@/stores/client-context-store";
import { ToolsPanel } from "./ToolsPanel";
import {
  ElectronWebviewPane,
  type ElectronWebviewHandle,
} from "./ElectronWebviewPane";
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
 * How long to wait for React to commit the embedded pane.
 *
 * A frame is all it should take. This exists so a start that somehow never
 * mounts fails with a sentence instead of hanging on a promise nobody settles.
 */
const PANE_MOUNT_TIMEOUT_MS = 2_000;

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
 * the viewer is actually in. Telling someone driving a datacenter browser to
 * look at a window on their own desk sends them hunting for something that is
 * not there.
 *
 * Every one of those per-transport differences lives in `viewportBehaviour`,
 * whose `satisfies never` makes the next transport kind a compile error here
 * instead of a silent fall-through to window behaviour.
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

  /**
   * Whether the next session should attach to a surface this screen mounts.
   *
   * AUTO-SELECTED rather than toggled. There is no third destination to offer:
   * inside the desktop app, "in app" already means "the page appears in this
   * pane", and a real Chromium surface is a strictly better way to be that
   * pane than a JPEG stream is. A hosted session is excluded because its
   * viewport is the Browser panel's, not ours.
   */
  const isElectron =
    typeof window !== "undefined" && window.isElectron === true;
  const isPackaged =
    typeof window !== "undefined" && window.isElectronPackaged === true;
  const useEmbeddedSurface = isElectron && inApp && !hosted;

  /** The mounted surface, and which start attempt it belongs to. */
  const [webviewMounted, setWebviewMounted] = useState(false);
  const [webviewAttempt, setWebviewAttempt] = useState(0);
  const webviewRef = useRef<ElectronWebviewHandle | null>(null);
  /** Resolver for a caller waiting on the pane React has yet to commit. */
  const paneWaiter = useRef<((handle: ElectronWebviewHandle) => void) | null>(
    null,
  );
  /**
   * True for the whole mount-attach-start flow, which the store's `starting`
   * does not cover: it goes true only once the request goes out. Both the
   * re-entry guard and the button's disabled state read this, so the guard and
   * what the person sees can never disagree.
   */
  const [openingSurface, setOpeningSurface] = useState(false);
  const openingSurfaceRef = useRef(false);
  /**
   * An error this screen produced rather than the server.
   *
   * Kept beside the store's, because a surface that never came up is not a
   * failed request — there was no request to fail.
   */
  const [localError, setLocalError] = useState<string | undefined>();

  /**
   * A callback ref rather than an object ref, because the MOUNT is the event
   * being waited on: React calls this on the commit that puts the pane on
   * screen, which is the earliest moment an id can be asked for.
   */
  const attachPane = useCallback((handle: ElectronWebviewHandle | null) => {
    webviewRef.current = handle;
    if (!handle) return;
    const waiter = paneWaiter.current;
    paneWaiter.current = null;
    waiter?.(handle);
  }, []);

  /**
   * Wait for the pane to mount, then for its guest to attach.
   *
   * Two waits, and they are different failures. The first is React's commit,
   * which is a frame away; the second is Chromium bringing a guest up, which
   * the pane bounds at five seconds of its own. Collapsing them into one
   * timeout would report a slow guest as a mount failure.
   */
  const nextWebviewId = useCallback(async (): Promise<number> => {
    const handle =
      webviewRef.current ??
      (await new Promise<ElectronWebviewHandle>((resolve, reject) => {
        paneWaiter.current = resolve;
        setTimeout(() => {
          if (paneWaiter.current !== resolve) return;
          paneWaiter.current = null;
          reject(new Error("The embedded browser pane did not appear."));
        }, PANE_MOUNT_TIMEOUT_MS);
      }));
    return handle.readyWebContentsId();
  }, []);

  // The browser outlives this screen on purpose — a developer may tab away
  // mid-flow — so unmounting closes the event stream and nothing else. Coming
  // back re-attaches to the session still running: without this, the header
  // would still say a browser is open while no tool registration or invocation
  // result could ever arrive, and an invoke would appear to hang forever.
  useEffect(() => {
    reconnect();
    return () => disconnect();
  }, [reconnect, disconnect]);

  /**
   * The surface is TAB-SCOPED, deliberately diverging from every other session.
   *
   * A browser the server started outlives this screen on purpose — a developer
   * may tab away mid-flow and come back to the same window. A surface this
   * screen mounted cannot: unmounting the component destroys the guest, so a
   * session left open would be attached to a `webContents` that no longer
   * exists, and every later command would fail against a browser nobody can
   * see. Closing it here is the honest end. (A persistent App-level webview
   * host, so the surface survives leaving the tab, is a documented follow-up.)
   */
  const webviewSessionRef = useRef(false);
  webviewSessionRef.current =
    webviewMounted && transportKindOf(session) === "electron-webview";
  const closeSessionRef = useRef(closeSession);
  closeSessionRef.current = closeSession;
  useEffect(
    () => () => {
      if (webviewSessionRef.current) void closeSessionRef.current();
    },
    [],
  );

  /**
   * Take the surface down once the session that was attached to it is over — a
   * crash, an idle sweep, or our own close all arrive the same way.
   *
   * The latch is what makes this correct. "No session" means two opposite
   * things at two different moments: BEFORE the start it means "mid-start, the
   * surface exists precisely so the request has something to attach to", and
   * after it means "the session ended". Without remembering which, this effect
   * unmounts the pane in the window between mounting it and the start request
   * coming back — destroying the guest the request is about to name.
   */
  const surfaceAttached = useRef(false);
  useEffect(() => {
    if (!webviewMounted) {
      surfaceAttached.current = false;
      return;
    }
    if (session && session.status !== "closed") {
      // Only OUR transport keeps the surface up. Any other kind means the
      // server is painting the viewport itself, and the pane it gave us is the
      // one the viewer needs to see.
      if (session.viewportTransport.kind === "electron-webview") {
        surfaceAttached.current = true;
        return;
      }
      setWebviewMounted(false);
      return;
    }
    if (surfaceAttached.current) setWebviewMounted(false);
  }, [webviewMounted, session]);

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
  /** Everything this screen does differently per transport, decided in one place. */
  const behaviour = viewportBehaviour(transportKind);
  /**
   * Whether the pane is meant to be showing a picture the SERVER produces.
   *
   * `electron-webview` is the kind that makes this more than a rename: its
   * surface paints itself, so "streaming" is false for it no matter what the
   * Live view toggle or the document's visibility say — there is no stream to
   * turn on, and asking for one would start a poll that overwrites nothing.
   */
  const streaming =
    live &&
    behaviour.serverPaints &&
    (liveView || behaviour.streamRequired) &&
    documentVisible;

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
   *
   * A client-owned surface has NEITHER. `streaming` is already false for it,
   * so this effect never runs — no `set_screencast` command, no poll timer, and
   * nothing to withdraw on unmount.
   */
  const pollsScreenshots = behaviour.pollsScreenshots;
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (cancelled || poll !== undefined) return;
      // `silent`, so a once-a-second capture cannot clear the error banner from
      // a navigation or invocation failure before anyone has read it.
      const shoot = () => void captureScreenshot({ silent: true });
      shoot();
      poll = setInterval(shoot, SCREENSHOT_POLL_MS);
    };

    if (pollsScreenshots) {
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
      if (!pollsScreenshots) void setScreencast(false);
    };
  }, [streaming, pollsScreenshots, setScreencast, captureScreenshot]);

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

  /**
   * MOUNT, THEN START — the ordering the whole embedded path hangs on.
   *
   * The server attaches to a surface rather than creating one, so the surface
   * has to exist and have a `webContentsId` BEFORE the start request is sent.
   * Starting first and mounting after would send a request with nothing to
   * attach to; mounting and starting in the same tick would send one with an
   * id that `getWebContentsId()` cannot produce yet (it throws until the guest
   * attaches). So: mount the pane, await its id, then start.
   *
   * `attempt` keys the pane so each start gets a FRESH element. Reusing one
   * across attempts would mean reusing a guest whose previous session left it
   * on the last page, and — worse — any code path that moved the element in the
   * DOM would destroy the guest silently.
   */
  const openBrowser = async () => {
    if (!useEmbeddedSurface) {
      await startSession(url, startOptions());
      return;
    }
    // RE-ENTRANCY is a real click, not a theoretical one. `starting` only goes
    // true once the request goes out, which is AFTER the mount-and-attach wait
    // — up to five seconds with the button still live. A second click in that
    // window re-keys the pane out from under the first attempt, whose waiter
    // then rejects and tears down the second attempt's surface, failing both
    // with an error neither of them caused.
    if (openingSurfaceRef.current) return;
    openingSurfaceRef.current = true;
    setOpeningSurface(true);
    setLocalError(undefined);
    // The previous attempt's handle, if any, must not answer for this one.
    webviewRef.current = null;
    setWebviewAttempt((attempt) => attempt + 1);
    setWebviewMounted(true);
    try {
      const webContentsId = await nextWebviewId();
      await startSession(url, { display: "in-app", webContentsId });
      // WHAT CAME BACK decides whether our surface is the viewport. A server
      // too old to know `webContentsId` strips it and answers `frame-stream` —
      // the documented degrade — and the streamed pane it gave us is the one to
      // render; leaving our surface up would hide it behind a blank
      // `about:blank`. A start that failed without throwing (the store reports
      // it as an error and leaves no session) lands here too, and the same
      // answer is right: take the dead surface down.
      //
      // Read from the store rather than the `session` in scope, which is the
      // render-time value from before the await.
      const started = useWebmcpInspectorStore.getState().session;
      if (started?.viewportTransport.kind !== "electron-webview") {
        setWebviewMounted(false);
      }
    } catch (error) {
      setWebviewMounted(false);
      setLocalError(
        error instanceof Error
          ? error.message
          : "The embedded browser did not start.",
      );
    } finally {
      openingSurfaceRef.current = false;
      setOpeningSurface(false);
    }
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
              : openBrowser());
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
            {/* Hidden when the stream is not optional (an in-app session has
                no other viewport) and when there is no stream at all (a
                client-owned surface is always on, and cannot be turned off
                without unmounting the session). */}
            {behaviour.streamRequired || !behaviour.serverPaints ? null : (
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
        {/* Hidden in the PACKAGED app, where "Chrome window" cannot work:
            forge ships `.vite` with no node_modules and `playwright` is
            externalized, so launching one always fails. A button that can only
            produce an error is worse than no button. */}
        {!live && !hosted && !isPackaged ? (
          <Button
            size="sm"
            variant="outline"
            aria-pressed={inApp}
            onClick={() => setInApp((on) => !on)}
            disabled={starting || openingSurface}
            title={
              inApp
                ? isElectron
                  ? "The page runs right here, in the app — click and type into it directly."
                  : "The page runs headless and appears in this pane; click and type into it here."
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
            disabled={starting || openingSurface}
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
            onClick={() => void openBrowser()}
            disabled={starting || openingSurface}
          >
            {starting || openingSurface ? "Opening…" : "Open browser"}
          </Button>
        ) : null}
        {session ? <StatusBadge status={session.status} /> : null}
      </header>

      {error || localError ? (
        <ErrorBanner
          message={error?.message ?? localError!}
          code={error?.code}
          onDismiss={() => {
            setLocalError(undefined);
            clearError();
          }}
        />
      ) : null}

      {live ? (
        <p className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          {/* Never promise a window that does not exist. A headless session has
              no viewport at all, and a HOSTED one has a browser running on a
              machine in a datacenter — telling someone to look at a window on
              their own desk would send them hunting for something that is not
              there. */}
          {behaviour.notice}
          {session?.url ? (
            <span className="ml-1 font-mono">{session.url}</span>
          ) : null}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-auto border-r">
          {/* The client-owned surface renders INSTEAD of the viewport pane, not
              inside it: the pane's aspect lock, image element and input
              forwarder are all wrong for a live Chromium view, and mounting it
              alongside would put two things on screen claiming to be the page.
              It also stays mounted while the start request is in flight, which
              is what makes mount-then-start possible. */}
          {webviewMounted ? (
            <ElectronWebviewPane
              key={webviewAttempt}
              ref={attachPane}
              onNavigate={setUrl}
              onError={setLocalError}
            />
          ) : live ? (
            <ViewportPane
              frame={liveFrame}
              fallbackScreenshot={lastScreenshot}
              streaming={streaming}
              transport={session?.viewportTransport}
              behaviour={behaviour}
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
  behaviour,
  onInput,
}: {
  frame: WebMcpFrame | undefined;
  fallbackScreenshot: string | undefined;
  streaming: boolean;
  transport: WebMcpViewportTransport | undefined;
  behaviour: ViewportBehaviour;
  onInput: (events: WebMcpInputEvent[]) => void;
}) {
  // The screenshot is a FALLBACK for a stream that is meant to be running, not
  // a still to leave up once it stops. With Live view off, holding it would
  // freeze the pane on an old picture still labelled "live" — and the "Live
  // view is off" placeholder would never appear, because a source was present.
  const source = frame?.data ?? (streaming ? fallbackScreenshot : undefined);
  /**
   * Whether this pane drives the page. Read from the one exhaustive table
   * rather than re-derived here, so a new transport kind cannot answer this
   * question differently from the rest of the screen.
   */
  const interactive = behaviour.drivesPage;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
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
    : transportSurface(transport);

  const frameSizeRef = useRef(surface);
  frameSizeRef.current = surface;
  /**
   * Keys whose key-DOWN was withheld, so the matching key-up can be withheld
   * too. See the paste handling in `onKeyDown`.
   *
   * Remembered rather than recomputed, because the modifier snapshot on the
   * key-up is not the one from the key-down: releasing Ctrl before V makes the
   * `v` key-up look like an ordinary keystroke, and forwarding it hands the
   * page a release for a key it never saw pressed. The mirror case — pressing
   * V, then Ctrl, then releasing V — is the same bug the other way round, and
   * a set gets both right where a predicate cannot.
   */
  const withheldKeys = useRef(new Set<string>());

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

  /**
   * Give up every piece of input state at once: the forwarder's held keys and
   * buttons, and the paste keys whose release is still owed.
   *
   * One function rather than two calls at four sites, because forgetting the
   * second half reintroduces exactly what withholding exists to prevent. A
   * `withheldKeys` left populated across a blur swallows the NEXT ordinary `v`
   * key-up — whose key-down WAS forwarded — and the page holds that key down
   * for the rest of the session.
   */
  const releaseAll = useCallback(() => {
    withheldKeys.current.clear();
    forwarder.releaseHeld();
  }, [forwarder]);

  useEffect(
    () => () => {
      // RELEASE, then dispose. Unmounting is not a blur — tabbing away from
      // this screen fires no blur on the pane — so disposing alone would clear
      // the held set locally while the page went on believing a key or button
      // was still down, for the rest of the session.
      releaseAll();
      forwarder.dispose();
    },
    [forwarder, releaseAll],
  );

  /**
   * Wheel, attached natively and NON-PASSIVELY.
   *
   * React registers `wheel` as a passive listener at its root, so
   * `preventDefault()` inside an `onWheel` prop is ignored — and without it the
   * same gesture scrolls the inspector's own column, sliding the pane out from
   * under the person while the page inside it also scrolls. The only way to
   * consume the event is to register it directly.
   */
  useEffect(() => {
    const element = paneRef.current;
    if (!element || !interactive) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      forwarder.wheel(event);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [interactive, forwarder]);

  // A pane that is no longer being driven must not leave keys held in the page.
  useEffect(() => {
    if (interactive) return;
    releaseAll();
  }, [interactive, releaseAll]);

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
        onPointerCancel: (event: React.PointerEvent) => {
          // The browser can cancel a pointer mid-drag (a touch interrupted, a
          // gesture taken over) with no pointerup to follow. Without this the
          // page keeps the button held and every later move reads as a drag.
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          releaseAll();
        },
        // Suppressed rather than forwarded: a native context menu opens in the
        // browser running the page, which is headless — so the menu would exist
        // nowhere and never appear in a frame, while this browser's own menu
        // covered the pane.
        onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
        onKeyDown: (event: React.KeyboardEvent) => {
          // Only while the pane holds focus, so the app's own shortcuts keep
          // working everywhere else.
          if (isComposing(event)) return;
          // ESCAPE IS THE WAY OUT, and is never forwarded. Tab IS forwarded —
          // tabbing between fields is most of what people do to a form — which
          // means Tab cannot also be the way out, and a keyboard-only user
          // would otherwise be trapped in the pane with no key that leaves it.
          // The caption says so while the pane has focus.
          if (event.key === "Escape") {
            event.preventDefault();
            (event.currentTarget as HTMLElement).blur();
            return;
          }
          // Paste is the one shortcut NOT swallowed locally: preventing its
          // default cancels the clipboard action, so no `paste` event fires and
          // the text never reaches the page. But its keystrokes must not be
          // FORWARDED either — `onPaste` already sends the clipboard as a text
          // event, and a `v` key-down with ctrl held would make the remote page
          // run its own paste as well, from a clipboard that is not the one the
          // person copied into.
          if (isPasteShortcut(event)) {
            withheldKeys.current.add(event.key.toLowerCase());
            return;
          }
          event.preventDefault();
          forwarder.keyDown(event.nativeEvent);
        },
        onKeyUp: (event: React.KeyboardEvent) => {
          if (isComposing(event)) return;
          // Matched to the keydown above: forwarding a lone key-up for a press
          // the page never saw would leave it releasing a key it never got.
          if (event.key === "Escape") return;
          // Paired with the key-down, not re-derived from this event's own
          // modifiers: whether Ctrl is still held when V comes up says nothing
          // about whether the V going down was forwarded.
          if (withheldKeys.current.delete(event.key.toLowerCase())) return;
          event.preventDefault();
          forwarder.keyUp(event.nativeEvent);
        },
        onPaste: (event: React.ClipboardEvent) => {
          event.preventDefault();
          forwarder.text(event.clipboardData.getData("text"));
        },
        onCompositionEnd: (event: React.CompositionEvent) => {
          // An IME commits its result here, and only here. Its key events carry
          // placeholder values like "Process", so a pane forwarding only keys
          // types nothing at all in Japanese, Chinese or Korean.
          forwarder.text(event.data);
        },
        onFocus: () => setFocused(true),
        onBlur: () => {
          setFocused(false);
          // The page never sees that focus left, so a modifier held at this
          // moment would stay held in it for the rest of the session and turn
          // every later click into a ctrl-click.
          releaseAll();
        },
      }
    : {};

  return (
    <figure className="m-0 border-b bg-muted/20 p-3">
      <div
        ref={paneRef}
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
              : behaviour.serverPaints
                ? "Live view is off. Turn it on to watch the page here."
                : behaviour.viewOnlyCaption}
          </p>
        )}
      </div>
      <figcaption className="pt-1 text-center text-[11px] text-muted-foreground">
        {interactive
          ? focused
            ? "Typing and clicking here goes to the page. Press Esc to leave."
            : "Click to interact with the page."
          : behaviour.viewOnlyCaption}
      </figcaption>
    </figure>
  );
}

/**
 * The session's transport kind, or undefined.
 *
 * A function rather than an inline read so the ref-sync above stays a single
 * expression; it runs on every render and must not allocate or branch on state
 * that could go stale between renders.
 */
function transportKindOf(
  session: { viewportTransport: WebMcpViewportTransport } | undefined,
): WebMcpViewportTransport["kind"] | undefined {
  return session?.viewportTransport.kind;
}

/** True while an IME is mid-composition; its key events are placeholders. */
function isComposing(event: React.KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.key === "Process";
}

/** Ctrl-V / Cmd-V, whose default action is the only way to reach the clipboard. */
function isPasteShortcut(event: React.KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
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
 * Everything this screen does differently per viewport kind, in ONE exhaustive
 * table.
 *
 * It used to be four separate `kind === "…"` comparisons scattered down the
 * component, each with an implicit "otherwise, behave like a native window".
 * That default is a trap: adding a transport meant the new kind silently
 * inherited window behaviour — the screencast asked for on a surface that
 * cannot stream, the input forwarder armed on a page that already receives
 * real input, and a notice telling the viewer to go look at a window that does
 * not exist — with nothing failing to compile and nothing failing at runtime
 * either. So the branch is a switch, and its default arm asserts `never`:
 * the NEXT kind added to the protocol is a typecheck failure here, and whoever
 * adds it decides these answers deliberately.
 */
interface ViewportBehaviour {
  /**
   * The SERVER produces this session's picture — as a frame stream, as polled
   * screenshots, or not at all.
   *
   * False means the surface paints itself where the viewer already is, so
   * nothing here should ask for frames, poll, or forward input.
   */
  serverPaints: boolean;
  /** Poll screenshots instead of asking for a stream; nothing streams here. */
  pollsScreenshots: boolean;
  /** The stream is the ONLY view, so "Live view: off" must not be offered. */
  streamRequired: boolean;
  /** Whether the pane forwards the viewer's input to the page. */
  drivesPage: boolean;
  /** Where the page actually is, for the notice above the pane. */
  notice: string;
  /** The pane's caption when it is a view rather than a surface. */
  viewOnlyCaption: string;
}

const NATIVE_WINDOW_BEHAVIOUR: ViewportBehaviour = {
  serverPaints: true,
  pollsScreenshots: false,
  streamRequired: false,
  // View-only on purpose: the person already has the real page in front of
  // them, and forwarding pane input would drive it a SECOND time — every click
  // landing twice, from two directions, with nothing reconciling them.
  drivesPage: false,
  notice:
    "A browser window is open on this machine — interact with the page there. Tools it registers appear here as they register.",
  viewOnlyCaption:
    "A live view of the page. Interact with it in the browser window.",
};

function viewportBehaviour(
  kind: WebMcpViewportTransport["kind"] | undefined,
): ViewportBehaviour {
  switch (kind) {
    // No session yet, so nothing is being shown. The window arm is the safe
    // answer: it asks for a stream that a started session would accept, and
    // drives nothing.
    case undefined:
    case "native-window":
      return NATIVE_WINDOW_BEHAVIOUR;
    case "headless":
      return {
        ...NATIVE_WINDOW_BEHAVIOUR,
        notice:
          "Running headless — no window to interact with. Tools, invocation and screenshots all work; use the Screenshot button to see the page.",
        viewOnlyCaption: "A live view of the headless page.",
      };
    case "remote-interactive-url":
      return {
        ...NATIVE_WINDOW_BEHAVIOUR,
        // The hosted browser paints somewhere else entirely; there is no
        // screencast on this side of the daemon to ask for.
        pollsScreenshots: true,
        notice:
          "This browser is running on your MCPJam computer, not on this machine. Open the Browser panel to watch it, or to take control when a sign-in needs you.",
        viewOnlyCaption:
          "Snapshots of your MCPJam computer's browser. Open the Browser panel to interact with it.",
      };
    case "frame-stream":
      return {
        ...NATIVE_WINDOW_BEHAVIOUR,
        // The pane is the only viewport, so its stream is not optional:
        // offering "Live view: off" would offer a browser nobody can see or
        // touch, with no way back except closing the session.
        streamRequired: true,
        drivesPage: true,
        notice:
          "This page is running in the pane below — click and type into it there. Tools it registers appear as they register.",
        viewOnlyCaption: "A live view of the page.",
      };
    case "electron-webview":
      return {
        // The one kind the client owns. Its pixels are a real Chromium surface
        // already on this screen, so there is nothing to encode, nothing to
        // poll, and no input to forward — the surface takes the viewer's mouse
        // and keyboard natively, which is the entire point of it.
        serverPaints: false,
        pollsScreenshots: false,
        streamRequired: false,
        drivesPage: false,
        notice:
          "This page is running right here, in the app — click and type into it directly. Tools it registers appear as they register.",
        viewOnlyCaption: "The page is running natively in this pane.",
      };
    default:
      // The guard this whole table exists for. A kind added to the protocol
      // lands here, fails to compile, and gets an answer chosen on purpose
      // rather than inherited from the window arm.
      kind satisfies never;
      return NATIVE_WINDOW_BEHAVIOUR;
  }
}

/**
 * The surface a `frame-stream` session reports, for laying the pane out before
 * the first frame arrives. Every other kind has no dimensions to report and
 * falls back to the viewport constant.
 */
function transportSurface(transport: WebMcpViewportTransport | undefined): {
  width: number;
  height: number;
} {
  switch (transport?.kind) {
    case "frame-stream":
      return { width: transport.width, height: transport.height };
    case undefined:
    case "native-window":
    case "headless":
    case "remote-interactive-url":
    case "electron-webview":
      return { width: WEBMCP_VIEWPORT.width, height: WEBMCP_VIEWPORT.height };
    default:
      transport satisfies never;
      return { width: WEBMCP_VIEWPORT.width, height: WEBMCP_VIEWPORT.height };
  }
}

import { LocalBrowserConsentGate } from "@/components/browser/LocalBrowserConsentGate";
import { useLocalBrowserConsent } from "@/hooks/useLocalBrowserConsent";
import { authFetch } from "@/lib/session-token";
import { BROWSER_CONSENT_HEADER } from "@/lib/local-browser-consent";
import { BrowserShell } from "@/components/browser/BrowserShell";
import {
  useBrowserSession,
  type BrowserSessionTransport,
} from "@/lib/browser-shell/use-browser-session";
import { decodeStateSnapshot } from "@/shared/browser-pane-wire";
import { useViewportReporter } from "@/lib/browser-pane/use-viewport-reporter";
import {
  readLastWebMcpUrl,
  writeLastWebMcpUrl,
} from "@/lib/webmcp-inspector/last-url";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Globe } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { useHostContextStore } from "@/stores/client-context-store";
import { ThreePanelLayout } from "@/components/ui/three-panel-layout";
import { ElectronNativeBody } from "@/components/browser/ElectronNativeBody";
import { ActivityTimeline } from "./ActivityTimeline";
import { WebmcpToolsSidebar } from "./WebmcpToolsSidebar";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import {
  buildOtlpExport,
  buildSessionExport,
  exportFilename,
} from "@/lib/webmcp-inspector/session-export";
import {
  parseHostedSessionId,
  WEBMCP_VIEWPORT,
} from "@/shared/webmcp-inspector-protocol";
import { createInputForwarder, type PaneFrame } from "@/lib/browser-pane/input";
import { fromBrowserPaneInput } from "@/shared/webmcp-input";
import { BrowserPaneSurface } from "@/components/browser/BrowserPaneSurface";
import type {
  WebMcpActivityEntry,
  WebMcpInputEvent,
  WebMcpViewportTransport,
} from "@/shared/webmcp-inspector-protocol";
import type { WebMcpLiveFrame } from "@/stores/webmcp-inspector-store";
import { notePainted } from "@/lib/webmcp-inspector/frame-stats";
import { BrowserPanel } from "@/components/computer/BrowserPanel";
import { HOSTED_MODE } from "@/lib/config";
import { copyWebMcpDiagnostics } from "@/lib/webmcp-inspector/diagnostics";

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

/**
 * The WebMCP workspace, laid out like the Tools tab: URL and tools on the
 * left, the live page in the center, activity as a log rail on the right.
 *
 * Every per-transport difference lives in `viewportBehaviour`, whose
 * `satisfies never` makes the next transport kind a compile error here
 * instead of a silent fall-through to window behaviour.
 */
export function WebmcpInspectorTab() {
  const consent = useLocalBrowserConsent();
  const {
    session,
    tools,
    activity,
    pending,
    starting,
    error,
    frameTransport,
    noteScreenshotPolling,
    startSession,
    closeSession,
    sendCommand,
    invokeTool,
    cancelInvocation,
    captureScreenshot,
    setScreencast,
    sendInput,
    clearError,
    clearActivity,
    reconnect,
    disconnect,
  } = useWebmcpInspectorStore(
    useShallow((state) => ({
      session: state.session,
      tools: state.tools,
      activity: state.activity,
      pending: state.pending,
      starting: state.starting,
      error: state.error,
      frameTransport: state.frameTransport,
      noteScreenshotPolling: state.noteScreenshotPolling,
      startSession: state.startSession,
      closeSession: state.closeSession,
      sendCommand: state.sendCommand,
      invokeTool: state.invokeTool,
      cancelInvocation: state.cancelInvocation,
      captureScreenshot: state.captureScreenshot,
      setScreencast: state.setScreencast,
      sendInput: state.sendInput,
      clearError: state.clearError,
      clearActivity: state.clearActivity,
      reconnect: state.reconnect,
      disconnect: state.disconnect,
    })),
  );

  const [url, setUrlState] = useState(readLastWebMcpUrl);
  const setUrl = useCallback((next: string) => {
    setUrlState(next);
    writeLastWebMcpUrl(next);
  }, []);
  // The field remounts when you leave this route. The session does not — so
  // the live page URL is the source of truth, and we write it so the next
  // visit still has it after the session is gone.
  useEffect(() => {
    if (session?.url) setUrl(session.url);
  }, [session?.url, setUrl]);
  const [selectedToolKey, setSelectedToolKey] = useState<string | undefined>();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [activityOpen, setActivityOpen] = useState(true);
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
   * Whether this viewer can start a hosted session at all.
   *
   * `activeProjectId` is the observable half of it. A guest never has one — a
   * project comes from a verified member session — so this also stands in for
   * "signed in", which is the OTHER thing the hosted route requires
   * (`requireVerifiedAuth` refuses a guest bearer outright). Deliberately not
   * read from a Convex auth hook: this tab renders in surfaces that mount no
   * Convex provider, and a hard dependency on one to decide a sentence of copy
   * would trade a real crash for a cosmetic gain.
   */
  const hostedReady = Boolean(activeProjectId);

  /**
   * Whether the next session should attach to a surface this screen mounts.
   *
   * AUTO-SELECTED rather than toggled. There is no third destination to offer:
   * inside the desktop app, "in app" already means "the page appears in this
   * pane", and a real Chromium surface is a strictly better way to be that
   * pane than a JPEG stream is. A hosted session is excluded because its
   * viewport is the Browser panel's, not ours.
   */
  const isPackaged =
    typeof window !== "undefined" && window.isElectronPackaged === true;

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
  /**
   * The project the OPEN session is running on, read off its own id.
   *
   * Not `activeProjectId`. That one moves the moment somebody switches
   * projects in the sidebar, and the browser panel below authorizes against
   * whatever it is handed — so a switch mid-session would point the viewport
   * at a different project's computer than the session it claims to be
   * showing. A hosted session id is `hosted:<projectId>:<computerId>`, so the
   * session carries the answer and cannot disagree with itself.
   */
  const sessionProjectId = parseHostedSessionId(session?.sessionId)?.projectId;
  const transportKind = session?.viewportTransport.kind;
  /** Everything this screen does differently per transport, decided in one place. */
  const behaviour = viewportBehaviour(transportKind);
  /**
   * Whether the pane is meant to be showing a picture the SERVER produces.
   *
   * `electron-native` is the kind that makes this more than a rename: its
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
  /**
   * The poll belongs to the SESSION, not just to the pane.
   *
   * A dependency rather than a detail: `streaming` and `pollsScreenshots` are
   * both unchanged when one `frame-stream` session replaces another, so
   * without this the effect never re-runs — and a poll started because the
   * OLD session's browser refused `set_screencast` would keep firing
   * screenshots at a new session whose socket works perfectly, with the badge
   * stuck on "Frames: polling". Re-running asks the new session the question
   * fresh, and the cleanup below stops the interval that answered it for the
   * old one.
   */
  const pollSessionId = session?.sessionId;
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
      // The poll is this surface's own fallback, so this surface is the only
      // thing that can report it. Without it the store would describe a pane
      // painting from screenshots as one that has no transport at all.
      noteScreenshotPolling(true);
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
      if (poll !== undefined) {
        clearInterval(poll);
        noteScreenshotPolling(false);
      }
      // Asked for whenever this session is still the current one, including
      // when the stream was never running: it is idempotent on the server, and
      // a session left encoding frames for a pane nobody is looking at is
      // exactly what demand-driving avoids.
      //
      // But ONLY while it is still the current one. `setScreencast` aims at
      // whatever session the store holds now, so a stop sent from a cleanup
      // that a session CHANGE triggered would stop the replacement's stream
      // rather than this one's — undone a moment later by the re-run below,
      // and only because the command queue happens to preserve that order.
      // The session this stream belonged to is gone, and its browser with it;
      // there is nothing left here to stop.
      const current = useWebmcpInspectorStore.getState().session?.sessionId;
      if (!pollsScreenshots && current === pollSessionId) {
        void setScreencast(false);
      }
    };
  }, [
    streaming,
    pollsScreenshots,
    pollSessionId,
    setScreencast,
    captureScreenshot,
    noteScreenshotPolling,
  ]);

  /**
   * Where this session's browser should run and appear.
   *
   * A hosted browser is watched and driven from the Browser panel, which has
   * its own take-control lease, so it never asks for the in-app pane — the
   * server refuses that combination and this avoids sending it at all.
   */
  const startOptions = () => {
    // Hosted is not a preference here, it is the only thing this deployment
    // can do — and the server refuses `local`, `display` and `webContentsId`
    // outright, so sending them would turn a working start into a 400.
    if (HOSTED_MODE) {
      return activeProjectId
        ? { transport: "hosted" as const, projectId: activeProjectId }
        : undefined;
    }
    if (hosted && activeProjectId) {
      return { transport: "hosted" as const, projectId: activeProjectId };
    }
    return {
      projectId: activeProjectId ?? undefined,
      ...(inApp ? { display: "in-app" as const } : {}),
    };
  };

  const openBrowser = async () => {
    if (HOSTED_MODE && !hostedReady) return;
    if (!HOSTED_MODE && !hosted && !consent.granted) return;
    await startSession(url, startOptions());
  };

  const pendingForSelected = pending.find(
    (item) => item.toolKey === selectedToolKey,
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

  const copyActivity = async (entries: WebMcpActivityEntry[]) => {
    const copied = await copyToClipboard(JSON.stringify(entries, null, 2));
    if (copied) toast.success("Activity copied");
    else toast.error("Could not copy activity to your clipboard");
  };

  const clearProfile = async (legacy = false) => {
    if (
      !window.confirm(
        legacy
          ? "Delete sign-ins and site data from the old shared WebMCP profile? New profiles are unaffected."
          : "Close inspection sessions and delete sign-ins and site data for this account and project? Saved transcripts and exports remain.",
      )
    )
      return;
    const response = await authFetch("/api/mcp/webmcp/profile", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        [BROWSER_CONSENT_HEADER]: consent.token ?? "",
      },
      body: JSON.stringify({ projectId: activeProjectId ?? undefined, legacy }),
    });
    if (response.ok) {
      if (!legacy) await closeSession();
      toast.success("Inspection site data cleared");
    } else toast.error("Could not clear inspection site data");
  };
  const overflowActions = [
    ...(!HOSTED_MODE && !hosted && isPackaged && consent.granted
      ? [
          {
            label: "Clear inspection site data",
            onSelect: () => void clearProfile(),
          },
          {
            label: "Delete old shared profile",
            onSelect: () => void clearProfile(true),
          },
        ]
      : []),
    ...(live
      ? [
          {
            label: "Close browser",
            onSelect: () => void closeSession(),
          },
          {
            label: "Screenshot",
            onSelect: () => void captureScreenshot(),
          },
        ]
      : []),
    ...(live && !behaviour.streamRequired && behaviour.serverPaints
      ? [
          {
            label: "Live view",
            onSelect: () => setLiveView((on) => !on),
            pressed: liveView,
          },
        ]
      : []),
    ...(!live && !hosted && !isPackaged && !HOSTED_MODE
      ? [
          {
            label: inApp ? "In app" : "Chrome window",
            onSelect: () => setInApp((on) => !on),
            pressed: inApp,
          },
        ]
      : []),
    ...(!live && activeProjectId && !HOSTED_MODE
      ? [
          {
            label: hosted ? "On my computer" : "On this machine",
            onSelect: () => setHosted((on) => !on),
            pressed: hosted,
          },
        ]
      : []),
    ...(session
      ? [
          {
            label: "Copy diagnostics",
            onSelect: () => {
              const { liveFrame } = useWebmcpInspectorStore.getState();
              void copyWebMcpDiagnostics({
                session,
                frameTransport,
                frame: liveFrame
                  ? {
                      deviceWidth: liveFrame.deviceWidth,
                      deviceHeight: liveFrame.deviceHeight,
                      seq: liveFrame.seq,
                    }
                  : undefined,
              });
            },
          },
        ]
      : []),
  ];

  const framesDegraded =
    transportKind === "frame-stream" &&
    ((frameTransport.rung === "sse-frames" && frameTransport.latched) ||
      frameTransport.rung === "poll");

  const showViewport = live;
  const hostedBlocked = HOSTED_MODE && !hostedReady;

  const framesBadge = framesDegraded ? (
    <Badge
      variant="outline"
      className="text-[10px]"
      title={
        frameTransport.rung === "poll"
          ? "This server cannot stream the viewport, so the pane is polling screenshots."
          : `The frame socket could not be used, so frames are riding the event stream. Attempts: ${frameTransport.attempts}`
      }
    >
      {frameTransport.rung === "poll" ? "Frames: polling" : "Frames: SSE"}
    </Badge>
  ) : null;

  const centerContent = showViewport ? (
    <div className="flex h-full min-h-0 flex-col">
      {live && behaviour.embedsBrowserPanel && sessionProjectId ? (
        /* The remote browser's own live view, in the pane rather than
           somewhere else to go and find.

           Mounted only once the session REPORTS this transport, never
           before: the panel mints a token for a desktop computer, and
           asking for one before the session has reserved that computer
           throws. `ensure={false}` for the same reason the panel refuses
           to reserve anywhere — a viewport must not be able to provision a
           machine; the session it is watching already did. */
        <div className="min-h-0 flex-1">
          <BrowserPanel projectId={sessionProjectId} ensure={false} />
        </div>
      ) : live ? (
        <WebMcpBrowserShell
          key={session?.sessionId}
          consentToken={consent.token}
          streaming={streaming}
          transport={session?.viewportTransport}
          behaviour={behaviour}
          onInput={sendInput}
          {...(framesBadge ? { trailing: framesBadge } : {})}
        />
      ) : null}
    </div>
  ) : (
    <div className="flex h-full items-center justify-center">
      <div className="mx-auto max-w-sm p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Globe className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="mb-1 text-xs font-semibold text-foreground">
          Open a page
        </p>
        <p className="text-xs font-medium text-muted-foreground">
          {hostedBlocked
            ? "A hosted browser runs on your own MCPJam computer, so it needs a signed-in account and a project to run under. Pick a project to get started — and note it cannot reach anything on your own network, including localhost."
            : "Enter a URL on the left to inspect the tools it registers."}
        </p>
      </div>
    </div>
  );

  if (!HOSTED_MODE && !hosted && !consent.granted) {
    return (
      <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-auto p-6">
        <LocalBrowserConsentGate onAllow={consent.grant} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {error ? (
        <ErrorBanner
          message={error!.message}
          code={error?.code}
          onDismiss={() => {
            clearError();
          }}
        />
      ) : null}

      <ThreePanelLayout
        id="webmcp"
        sidebar={
          <WebmcpToolsSidebar
            url={url}
            onUrlChange={setUrl}
            onUrlSubmit={() => {
              void (live
                ? sendCommand({ type: "navigate", url })
                : openBrowser());
            }}
            tools={tools}
            selectedToolKey={selectedToolKey}
            onSelectTool={setSelectedToolKey}
            hasSession={live}
            live={live}
            starting={starting}
            pendingInvokeId={pendingForSelected?.invokeId}
            primaryLabel={live ? "Go" : starting ? "Opening…" : "Open browser"}
            primaryDisabled={starting || hostedBlocked}
            primaryTitle={
              hostedBlocked
                ? "Sign in and pick a project first — the browser runs on that project's computer."
                : undefined
            }
            onPrimary={() => {
              void (live
                ? sendCommand({ type: "navigate", url })
                : openBrowser());
            }}
            overflowActions={overflowActions}
            onClose={() => setSidebarVisible(false)}
            onInvoke={(input) => {
              if (!selectedToolKey) return;
              void invokeTool(selectedToolKey, input);
            }}
            onCancel={(invokeId) => void cancelInvocation(invokeId)}
          />
        }
        content={centerContent}
        sidebarVisible={sidebarVisible}
        onSidebarVisibilityChange={setSidebarVisible}
        sidebarTooltip="Show tools"
        right={
          <ActivityTimeline
            entries={activity}
            onCopy={(entries) => void copyActivity(entries)}
            onExportJson={() => exportAs("json")}
            onExportOtlp={() => exportAs("otlp")}
            onClear={clearActivity}
            onClose={() => setActivityOpen(false)}
          />
        }
        rightVisible={activityOpen}
        onRightVisibilityChange={setActivityOpen}
        rightTooltip="Show activity"
      />
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
function WebMcpBrowserShell(
  props: Parameters<typeof SubscribedViewportPane>[0] & {
    consentToken: string | null;
    trailing?: ReactNode;
  },
) {
  const transport = useMemo<BrowserSessionTransport>(
    () => ({
      readState: async () => {
        const result = (await useWebmcpInspectorStore
          .getState()
          .sendCommand({ type: "browser_state" })) as { state: unknown };
        return decodeStateSnapshot(result.state);
      },
      sendCommand: async ({ command }) => {
        await useWebmcpInspectorStore
          .getState()
          .sendCommand({ type: "browser_command", command });
        return { ok: true };
      },
    }),
    [],
  );
  const native =
    props.transport?.kind === "electron-native" ? props.transport : undefined;
  const shell = useBrowserSession({
    transport: props.behaviour.drivesPage || native ? transport : null,
    holderId: null,
    active: true,
    pollMs: 500,
  });
  const sendToTab = useCallback(
    (events: WebMcpInputEvent[]) => {
      const send = useWebmcpInspectorStore.getState().sendInput;
      return shell.state.activeTabId
        ? send(events, shell.state.activeTabId)
        : send(events);
    },
    [shell.state.activeTabId],
  );
  if (!props.behaviour.drivesPage && !native)
    return <SubscribedViewportPane {...props} />;
  return (
    <BrowserShell
      enabled
      authority={{ kind: "shared" }}
      state={shell.state}
      holderId={null}
      onCommand={shell.run}
      ready={shell.supported}
      notice={shell.notice}
      error={shell.error}
      {...(props.trailing ? { trailing: props.trailing } : {})}
    >
      {native ? (
        <ElectronNativeBody
          session={{ bootId: native.bootId }}
          holder="webmcp-inspector"
          control="agent"
          holding={false}
          consentGranted
          consentToken={props.consentToken}
          chrome="none"
        />
      ) : (
        <SubscribedViewportPane
          key={shell.state.activeTabId}
          {...props}
          onInput={sendToTab}
        />
      )}
    </BrowserShell>
  );
}

/** Frames update only the viewport, never the tools and activity workspace. */
function SubscribedViewportPane(
  props: Omit<
    Parameters<typeof ViewportPane>[0],
    "frame" | "fallbackScreenshot" | "fallbackScreenshotAt"
  >,
) {
  const frame = useWebmcpInspectorStore((state) => state.liveFrame);
  const fallbackScreenshot = useWebmcpInspectorStore(
    (state) => state.lastScreenshot,
  );
  const fallbackScreenshotAt = useWebmcpInspectorStore(
    (state) => state.lastScreenshotAt,
  );
  return (
    <ViewportPane
      {...props}
      frame={frame}
      fallbackScreenshot={fallbackScreenshot}
      fallbackScreenshotAt={fallbackScreenshotAt}
    />
  );
}

function ViewportPane({
  frame,
  fallbackScreenshot,
  fallbackScreenshotAt,
  streaming,
  transport,
  behaviour,
  onInput,
}: {
  frame: WebMcpLiveFrame | undefined;
  fallbackScreenshot: string | undefined;
  /** When the server had `fallbackScreenshot`; see the store's field. */
  fallbackScreenshotAt: number | undefined;
  streaming: boolean;
  transport: WebMcpViewportTransport | undefined;
  behaviour: ViewportBehaviour;
  /** The promise bounds outstanding batches; the ordered socket pipelines them. */
  onInput: (events: WebMcpInputEvent[]) => void | Promise<void>;
}) {
  const surface = frame
    ? { width: frame.cssWidth, height: frame.cssHeight }
    : transportSurface(transport);
  // ViewportPane is keyed by sessionId; a retired pane cancels its report.
  const resize = useViewportReporter((size) => {
    if (!behaviour.drivesPage) return;
    return useWebmcpInspectorStore
      .getState()
      .sendCommand({ type: "set_viewport", ...size });
  }, behaviour.drivesPage);
  const inputLifecycle = useMemo(
    () => ({
      forwarder: createInputForwarder((events) =>
        onInput(events.map(fromBrowserPaneInput)),
      ),
      attached: false,
    }),
    [onInput],
  );
  const { forwarder } = inputLifecycle;
  useEffect(() => {
    inputLifecycle.attached = true;
    return () => {
      inputLifecycle.attached = false;
      // Child cleanup still needs to release held input. Strict Mode may also
      // reattach this same forwarder before the deferred cleanup runs.
      queueMicrotask(() => {
        if (!inputLifecycle.attached) inputLifecycle.forwarder.cancel();
      });
    };
  }, [inputLifecycle]);
  const input = useCallback(
    (events: Parameters<typeof forwarder.push>[0]) => {
      if (behaviour.drivesPage) forwarder.push(events);
    },
    [behaviour.drivesPage, forwarder],
  );
  const picture = useMemo<PaneFrame | null>(() => {
    if (frame)
      return {
        src: frame.src,
        deviceWidth: frame.deviceWidth,
        deviceHeight: frame.deviceHeight,
        scale: frame.deviceWidth / frame.cssWidth,
        ts: frame.ts,
        seq: frame.seq,
      };
    if (streaming && fallbackScreenshot)
      return {
        data: fallbackScreenshot,
        deviceWidth: surface.width,
        deviceHeight: surface.height,
        scale: 1,
        ts: fallbackScreenshotAt ?? Date.now(),
        seq: -1,
      };
    return null;
  }, [
    frame,
    streaming,
    fallbackScreenshot,
    fallbackScreenshotAt,
    surface.width,
    surface.height,
  ]);
  const painted = useCallback(() => {
    if (frame) notePainted(frame);
    else if (fallbackScreenshotAt !== undefined)
      notePainted({ ts: fallbackScreenshotAt, rung: "poll" });
  }, [frame, fallbackScreenshotAt]);
  return (
    <figure className="m-0 flex h-full min-h-0 flex-col bg-muted/20 p-3">
      <BrowserPaneSurface
        frame={picture}
        authority={
          behaviour.drivesPage
            ? { kind: "shared" }
            : { kind: "lease", holding: false }
        }
        control="you"
        chrome="none"
        label="Live view of the inspected page"
        interactionLabel={
          behaviour.drivesPage
            ? "The inspected page — click to interact"
            : undefined
        }
        onInput={input}
        onPainted={painted}
        onViewportSize={behaviour.drivesPage ? resize : undefined}
        placeholder={
          <p className="text-center text-xs text-muted-foreground">
            {streaming
              ? "Waiting for the first frame…"
              : behaviour.serverPaints
              ? "Live view is off. Turn it on to watch the page here."
              : behaviour.viewOnlyCaption}
          </p>
        }
      />
      <figcaption className="pt-1 text-center text-[11px] text-muted-foreground">
        {behaviour.drivesPage
          ? "Click to interact with the page. Press Shift+Esc to leave."
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

/**
 * The failure modes worth spelling out. Each one is a different thing for the
 * reader to do, so each gets its own sentence rather than a generic "error".
 *
 * A map rather than a ladder because the hosted transport roughly doubled the
 * list, and because the cost of a missing entry is invisible: the server's own
 * sentence still renders, so a code nobody added here reads as "something went
 * wrong" with no next step, and nothing fails to make that noticeable.
 */
const ERROR_GUIDANCE: Record<string, string> = {
  // Local browser problems.
  "webmcp-unsupported":
    "The page loaded, but this browser build cannot expose WebMCP tools, so there is nothing to inspect.",
  "no-display":
    "Running over SSH or in a container? Restart the inspector with MCPJAM_WEBMCP_HEADLESS=true to inspect tools without a visible window.",
  "chromium-not-installed":
    "Chromium could not be found or installed. Run `npx playwright install chromium` and try again.",
  capacity: "Close an open browser session before starting another.",
  "session-not-found": "Open the page again to start a new session.",

  // Hosted: what the person can actually do about each one.
  "hosted-desktop-asleep":
    "Your computer went to sleep. Open the page again to wake it — this view will not wake it for you, because waking starts billing again.",
  "hosted-forbidden":
    "An organization admin can turn Computers on for your organization.",
  "hosted-at-capacity":
    "Try again in a few minutes, or close a computer you are not using.",
  "hosted-reserve-timeout":
    "Try again — a computer that is starting cold usually comes up on the second attempt.",
  "hosted-provision-failed":
    "Your computer could not start. Try again, and if it keeps failing an operator will need to look at it.",
  "hosted-desktop-deleted":
    "That computer is gone. Open the page again to get a new one.",
  "hosted-desktop-unconfigured":
    "Hosted browsers are not finished being set up on this deployment. An operator needs to configure the desktop runtime.",
  "hosted-unconfigured":
    "This server cannot reach MCPJam computers right now. Try again shortly.",
  "hosted-guest-unsupported":
    "Sign in to run a browser — it runs on your own MCPJam computer, which a guest session does not have.",
  "hosted-auth-required": "Sign in again to run a browser on your computer.",
  "hosted-project-required":
    "Pick a project first — the browser runs on that project's computer.",
  "hosted-browser-disabled":
    "Hosted browsers are turned off on this server right now.",
  "hosted-local-unsupported":
    "This inspector only runs browsers on your MCPJam computer. For a browser on this machine, run the inspector locally with `npx @mcpjam/inspector`.",
  "lease-blocked":
    "Someone has taken control of this browser. Hand it back from the view above to let tools run again.",
};

function ErrorBanner({
  message,
  code,
  onDismiss,
}: {
  message: string;
  code?: string;
  onDismiss: () => void;
}) {
  // Own keys only. A server code of `__proto__` or `constructor` otherwise
  // resolves through the prototype chain to something that is not a string,
  // and React is handed a child it cannot render.
  const guidance =
    code && Object.prototype.hasOwnProperty.call(ERROR_GUIDANCE, code)
      ? ERROR_GUIDANCE[code]
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
 * real input — with nothing failing to compile and nothing failing at runtime
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
  /** The pane's caption when it is a view rather than a surface. */
  viewOnlyCaption: string;
  /**
   * The pane IS the Browser panel — a live stream of a browser running
   * somewhere else, with its own take-control handoff.
   *
   * Only a remote browser sets this. It replaces the polled screenshot, which
   * was proof of life rather than a viewport, and it is what makes a sign-in
   * on a hosted page possible at all: the person has to be able to type into
   * that browser, and the panel's lease is how they get to.
   */
  embedsBrowserPanel?: boolean;
}

const NATIVE_WINDOW_BEHAVIOUR: ViewportBehaviour = {
  serverPaints: true,
  pollsScreenshots: false,
  streamRequired: false,
  // View-only on purpose: the person already has the real page in front of
  // them, and forwarding pane input would drive it a SECOND time — every click
  // landing twice, from two directions, with nothing reconciling them.
  drivesPage: false,
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
        viewOnlyCaption: "A live view of the headless page.",
      };
    case "remote-interactive-url":
      return {
        ...NATIVE_WINDOW_BEHAVIOUR,
        // The remote browser publishes its OWN viewport, and the pane embeds
        // it. So this side neither streams nor polls: there is no CDP
        // screencast on this side of the daemon to ask for, and the
        // once-a-second screenshot it used to fall back to was proof of life
        // rather than a picture anyone could work with.
        serverPaints: false,
        pollsScreenshots: false,
        embedsBrowserPanel: true,
        viewOnlyCaption:
          "A live view of your MCPJam computer's browser. Take control to sign in or answer a challenge.",
      };
    case "frame-stream":
      return {
        ...NATIVE_WINDOW_BEHAVIOUR,
        // The pane is the only viewport, so its stream is not optional:
        // offering "Live view: off" would offer a browser nobody can see or
        // touch, with no way back except closing the session.
        streamRequired: true,
        drivesPage: true,
        viewOnlyCaption: "A live view of the page.",
      };
    case "electron-native":
      return {
        // The one kind the client owns. Its pixels are a real Chromium surface
        // already on this screen, so there is nothing to encode, nothing to
        // poll, and no input to forward — the surface takes the viewer's mouse
        // and keyboard natively, which is the entire point of it.
        serverPaints: false,
        pollsScreenshots: false,
        streamRequired: false,
        drivesPage: false,
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
    case "electron-native":
      return { width: WEBMCP_VIEWPORT.width, height: WEBMCP_VIEWPORT.height };
    default:
      transport satisfies never;
      return { width: WEBMCP_VIEWPORT.width, height: WEBMCP_VIEWPORT.height };
  }
}

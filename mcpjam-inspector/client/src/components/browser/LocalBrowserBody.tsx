import {
  releaseBrowserForChat,
  useBrowserChatHandoff,
} from "@/lib/browser-shell/chat-handoff";
import { useBrowserWorkspaceEnabled } from "@/hooks/useComputersEnabled";
import {
  browserPageToolsKey,
  noteWebmcpStats,
  useBrowserPageToolsStore,
} from "@/stores/browser-page-tools-store";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BrowserWorkspaceChrome } from "./BrowserWorkspaceChrome";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { PaneMessage } from "@/components/computer/PaneMessage";
import { LocalBrowserConsentGate } from "@/components/browser/LocalBrowserConsentGate";
import { useLocalBrowserConsent } from "@/hooks/useLocalBrowserConsent";
import {
  BrowserPaneSurface,
  type PaneControl,
} from "@/components/browser/BrowserPaneSurface";
import { ElectronNativeBody } from "@/components/browser/ElectronNativeBody";
import { BrowserShell } from "@/components/browser/BrowserShell";
import { PaneSettingsMenu } from "@/components/browser/PaneControlBar";
import { BrowserSettingsButton } from "@/components/browser/BrowserSettingsButton";
import { BrowserProfileSaveButton } from "@/components/browser/BrowserProfileSaveButton";
import { useBrowserSession } from "@/lib/browser-shell/use-browser-session";
import {
  paneInteractionAnchor,
  TAKEOVER_RETRY_NOTICE,
} from "../../../../shared/browser-pane-command";
import type { BrowserPaneCommand } from "../../../../shared/browser-pane-command";
import type { BrowserInputEvent, PaneFrame } from "@/lib/browser-pane/input";
import { paneFrameStats } from "@/lib/browser-pane/frame-stats";
import { createFrameWireReader } from "@/lib/browser-pane/frame-wire";
import { captureBrowserPaneSessionSummary } from "@/lib/browser-pane/session-summary";
import {
  actOnLocalBrowserLease,
  fetchLocalBrowserState,
  reportLocalPaneViewport,
  sendLocalPaneCommand,
  createInputForwarder,
  ensureLocalBrowser,
  fetchLocalBrowserSession,
  fetchLocalBrowserStatus,
  mintLocalBrowserFrameNonce,
  noteLocalBrowserWatch,
  openLocalBrowserFrameStream,
  sendLocalBrowserInput,
  fetchLocalBrowserProfileArchive,
  startLocalBrowserInstall,
  type LocalBrowserLease,
  type LocalBrowserStatus,
  LocalBrowserRequestError,
} from "@/lib/local-browser/client";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { usePaneHolderId } from "@/lib/local-browser/pane-holder";

/**
 * The frame socket's close codes, mirroring `routes/web/local-browser-frames`.
 *
 * Named here rather than left as bare numbers because the pane's behaviour
 * differs per code: one is worth waiting out, the other never will be.
 */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_LEASE_HELD = 4409;

/**
 * The agent's browser, in the Playground rail.
 *
 * Two things a person needs from it. WATCHING, because an agent driving a
 * browser they cannot see is one they cannot trust or correct. And TAKING
 * OVER, because the agent will hit a CAPTCHA or an SSO prompt it cannot solve,
 * and without a way in the run simply stops.
 *
 * What this file owns is everything the LOCAL engine does differently:
 * downloading a Chromium, minting a frame nonce against device consent, and a
 * lease identity kept in `sessionStorage` because there is no signed-in user
 * to be. The picture, the pointer and the take-control bar are
 * `BrowserPaneSurface`, shared with the hosted pane — what a person does to a
 * rendered browser does not depend on where it runs.
 */

/**
 * What the pane says when the server refuses its input.
 *
 * A constant because the re-read below has to be able to RETRACT exactly this
 * message and nothing else — clearing whatever `error` happens to hold would
 * swallow a real failure that arrived in the meantime.
 */
const SOMEBODY_ELSE_HAS_IT =
  "Somebody else has taken control of this browser. The view will resume when they hand it back.";

/** How often to ask again while somebody else is holding the browser. */
const LEASE_RECHECK_MS = 5_000;

export function LocalBrowserBody({
  projectId,
  sessionId,
  consentGranted,
  consentToken,
  hostId = null,
  active = true,
  onSessionReady,
}: {
  projectId: string | null;
  /** Durable logical session, when this pane belongs to a conversation. */
  sessionId?: string;
  consentGranted: boolean;
  consentToken: string | null;
  /** Client id for the Browser settings button in the nav bar. */
  hostId?: string | null;
  /**
   * Is this pane the rail's visible tab?
   *
   * The pane stays MOUNTED when the user looks at the logs — dropping the
   * socket would stop the screencast and make the browser go dark on every
   * glance — so `document.visibilityState` cannot answer this: the document is
   * still visible, it is this pane that is not. Watching is what defers the
   * idle reap, so a hidden pane must stop claiming somebody is watching.
   */
  active?: boolean;
  /** Notify comparison chrome when a manual start or an existing session is found. */
  onSessionReady?: () => void;
}) {
  const workspaceEnabled = useBrowserWorkspaceEnabled();
  const comparisonWorkspace = useContext(BrowserWorkspaceChrome);
  const { grant: grantConsent } = useLocalBrowserConsent();
  const [status, setStatus] = useState<LocalBrowserStatus | null>(null);
  const [session, setSession] = useState<{ bootId: string } | null>(null);
  const sessionReadyRef = useRef(onSessionReady);
  sessionReadyRef.current = onSessionReady;
  useEffect(() => {
    if (session) sessionReadyRef.current?.();
  }, [session]);
  const [lease, setLease] = useState<LocalBrowserLease>({ state: "free" });
  const [frame, setFrame] = useState<PaneFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lookupKey = JSON.stringify([projectId, sessionId, consentToken]);
  const [lookupComplete, setLookupComplete] = useState<string | null>(null);
  const [statusResolved, setStatusResolved] = useState(false);
  const autoStartAttempted = useRef(false);
  // Bumped to re-open the frame socket after it was refused — see the 4401
  // branch below.
  const [streamAttempt, setStreamAttempt] = useState(0);
  const markBrowserSessionActive = useActiveChatSessionStore(
    (state) => state.markBrowserSessionActive,
  );
  /**
   * This pane's identity as a lease holder.
   *
   * Per TAB and stable across reloads, not per mount. It only has to tell one
   * pane from another so two tabs cannot each believe they have control — on a
   * single-user machine the boundary is device consent, and nothing downstream
   * treats this as proof of who anybody is.
   *
   * Stability is what makes it safe, though. A hold that runs out PARKS rather
   * than freeing (a timer expiring is not evidence the private moment is
   * over), and only its holder may hand it back. Minted per mount, reloading
   * while holding left the lease parked under a holder that no longer existed:
   * the agent blocked, every new pane refused, and nothing but restarting the
   * server could clear it. Kept in `sessionStorage` — per tab, surviving a
   * reload, gone when the tab is — the returning pane is recognised as the
   * same hands it was before.
   */
  const paneHolder = usePaneHolderId();
  const holder = comparisonWorkspace?.holderId ?? paneHolder;
  /**
   * The live socket and what it said it could do — see the hosted pane's twin.
   *
   * A ref, so a reconnect does not rebuild the input forwarder mid-drag and
   * drop its queue, and because `hello` lands after the forwarder exists.
   */
  const socketRef = useRef<WebSocket | null>(null);
  const socketInputRef = useRef(false);
  /** The seq on screen when a gesture goes, for the input→paint sample. */
  const frameSeqRef = useRef(0);
  const holding = lease.state !== "free" && lease.holder === holder;
  /**
   * Can THIS build show a real view, rather than a picture of one?
   *
   * Asked of the main process, and separately from the server's `surface`:
   * the server answers "this engine has views to show", and this answers "this
   * Electron and this preload can show them". A desktop app older than this
   * wave says `installed` and `runtime: "electron"` exactly as a new one does
   * and has no channel to ask — so a pane that branched on the server's answer
   * alone would render a slot nothing ever paints into.
   *
   * `null` means not asked yet, which is deliberately NOT native: the frames
   * path is what has always worked, and no socket opens before there is a
   * browser anyway.
   */
  const [nativeCapable, setNativeCapable] = useState<boolean | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.agentBrowser;
    if (!api) {
      setNativeCapable(false);
      return;
    }
    let cancelled = false;
    void api
      .capability(consentToken)
      .then((result) => {
        if (!cancelled) setNativeCapable(Boolean(result?.available));
      })
      .catch(() => {
        if (!cancelled) setNativeCapable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [consentToken]);
  /**
   * Show the page itself rather than a screencast of it.
   *
   * THREE conditions, and each rules out a different way this can be wrong:
   * the engine is Electron, the server built its context with views
   * (`MCPJAM_BROWSER_NATIVE_SURFACE=false` turns that off without a rebuild),
   * and this app can actually place one.
   */
  const native =
    status?.runtime === "electron" &&
    status?.surface === "native" &&
    nativeCapable === true;
  // Read inside the heartbeat interval, which must not be torn down and
  // rebuilt (and the socket with it) every time the user changes tab.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    void fetchLocalBrowserStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setStatusResolved(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(null);
          setStatusResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While Chromium downloads, poll: it is hundreds of megabytes and a screen
  // that looks frozen for several minutes reads as broken.
  useEffect(() => {
    if (status?.install.status !== "installing") return;
    const timer = setInterval(() => {
      void fetchLocalBrowserStatus()
        .then(setStatus)
        .catch(() => {});
    }, 1_000);
    return () => clearInterval(timer);
  }, [status?.install.status]);

  const install = useCallback(async () => {
    setError(null);
    try {
      const { install: state } = await startLocalBrowserInstall(consentToken);
      setStatus((prev) => (prev ? { ...prev, install: state } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [consentToken]);

  /**
   * Which project the state below belongs to.
   *
   * The pane is mounted once and its `projectId` changes underneath it. A
   * session, a lease and a frame are all bound to ONE project's browser, so
   * carrying them across a switch would show one project's page in another's
   * rail — and, worse, aim input at it. A start already in flight is
   * abandoned for the same reason.
   */
  const projectRef = useRef(projectId);
  /**
   * Which browser this pane is looking at, as a number that only goes up.
   *
   * The project id alone cannot say: switch A → B → A and it reads "A" again,
   * so a lease response from the FIRST A is accepted as if it described the
   * browser now on screen — a "you have control" from a browser nobody is
   * watching any more. Two visits to the same project are two different
   * browsers, and so are two `start()` calls within one project; a counter is
   * the only thing that tells them apart.
   */
  const railGeneration = useRef(0);
  // CONSENT REVOKED IS A PRIVACY BOUNDARY, and the surface cannot enforce it:
  // it renders the picture whenever there is one, so a placeholder alone left
  // the last captured frame of somebody's signed-in browser on screen after
  // the grant was withdrawn. The socket does close on its own — its nonce
  // carries a consent fingerprint — but not before the next frame, and never
  // for the one already in state.
  useEffect(() => {
    if (!consentGranted) {
      railGeneration.current += 1;
      autoStartAttempted.current = false;
      setLookupComplete(null);
      setSession(null);
      setLease({ state: "free" });
      setFrame(null);
    }
  }, [consentGranted]);

  /**
   * And which conversation. A durable session is a browser identity in its own
   * right — the agent drives `<project>:session:<id>` — so carrying a session,
   * a lease and a frame across a conversation switch shows one conversation's
   * browser in another's rail, and aims input at it.
   */
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (projectRef.current === projectId && sessionRef.current === sessionId) {
      return;
    }
    // Switching chats reconnects existing tabs but does not launch another
    // Chromium merely because the browser pane was left open.
    autoStartAttempted.current =
      projectRef.current === projectId && sessionRef.current !== sessionId;
    projectRef.current = projectId;
    sessionRef.current = sessionId;
    setLookupComplete(null);
    railGeneration.current += 1;
    setSession(null);
    setLease({ state: "free" });
    setFrame(null);
    setError(null);
  }, [projectId, sessionId]);

  useEffect(() => {
    if (active) autoStartAttempted.current = false;
  }, [active]);

  // The browser outlives this pane. Returning to a conversation reconnects to
  // its live tabs; it must not create a new browser or reload the saved URL.
  // While empty, also notice a browser started by the agent after the pane
  // opened. Hidden panes do not poll. The first read lets startup reuse live tabs.
  useEffect(() => {
    if (!active || !consentGranted || !projectId || !sessionId || session)
      return;
    const generation = railGeneration.current;
    let cancelled = false;
    let retryMs = 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (document.visibilityState !== "visible") {
        timer = setTimeout(() => void refresh(), 2_000);
        return;
      }
      try {
        const next = await fetchLocalBrowserSession(
          projectId,
          consentToken,
          sessionId,
        );
        if (cancelled || railGeneration.current !== generation) return;
        if (next) {
          autoStartAttempted.current = true;
          railGeneration.current += 1;
          setSession({ bootId: next.bootId });
          setLease(next.lease);
          markBrowserSessionActive(sessionId);
          setError(null);
        } else {
          setLookupComplete(lookupKey);
          timer = setTimeout(() => void refresh(), 2_000);
        }
      } catch {
        if (cancelled || railGeneration.current !== generation) return;
        setLookupComplete(lookupKey);
        // An unavailable read is not evidence that this conversation is empty.
        retryMs = Math.min(retryMs * 2, 30_000);
        timer = setTimeout(() => void refresh(), retryMs);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    active,
    consentGranted,
    consentToken,
    projectId,
    sessionId,
    session,
    markBrowserSessionActive,
    lookupKey,
  ]);

  const start = useCallback(async () => {
    if (!projectId || !consentGranted) return;
    autoStartAttempted.current = true;
    setBusy(true);
    setError(null);
    // Captured BEFORE the await, and compared after, exactly as `exportProfile`
    // below does. The project check alone is not enough: a conversation switch
    // stays inside one project, bumps this counter, and would otherwise let A's
    // late answer install into B's pane — where the frame and input routes,
    // keyed by project plus bootId, would happily show and drive A's browser
    // under B's identity.
    const generation = railGeneration.current;
    try {
      const next = await ensureLocalBrowser(projectId, consentToken, sessionId);
      if (
        projectRef.current !== projectId ||
        railGeneration.current !== generation
      ) {
        return;
      }
      // A different browser from here on, even within this project: anything
      // still in flight against the last one must not land on this one.
      railGeneration.current += 1;
      setSession({ bootId: next.bootId });
      if (sessionId) {
        markBrowserSessionActive(sessionId);
        useActiveChatSessionStore
          .getState()
          .setBrowserLocation({ projectId, sessionId, engine: "local" });
      }
      setLease(next.lease);
    } catch (err) {
      if (
        projectRef.current !== projectId ||
        railGeneration.current !== generation
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    markBrowserSessionActive,
    projectId,
    consentGranted,
    consentToken,
    sessionId,
  ]);

  // Opening the visible Browser tab is the launch action. Consent remains a
  // separate capability check, but granting it needs no second launch click.
  // Attempt once per visit/identity: a failure or a closed browser must not
  // turn into an automatic restart loop.
  useEffect(() => {
    if (
      comparisonWorkspace ||
      !active ||
      !consentGranted ||
      !projectId ||
      session ||
      busy ||
      !statusResolved ||
      status?.installed === false ||
      (sessionId && lookupComplete !== lookupKey) ||
      autoStartAttempted.current
    )
      return;
    autoStartAttempted.current = true;
    void start();
  }, [
    comparisonWorkspace,
    active,
    consentGranted,
    projectId,
    sessionId,
    session,
    busy,
    status?.installed,
    statusResolved,
    lookupKey,
    lookupComplete,
    start,
  ]);

  const exportProfile = useCallback(async () => {
    if (!session || !projectId) {
      throw new Error("Open a browser before saving its profile.");
    }
    const generation = railGeneration.current;
    await releaseBrowserForChat(projectId, sessionId);
    const result = await fetchLocalBrowserProfileArchive({
      bootId: session.bootId,
      projectId,
      ...(sessionId ? { sessionId } : {}),
      consentToken,
    });
    // The export CLOSED that browser, so the pane must forget it — but only
    // while it is still the browser on screen. A switch mid-request means
    // these setters would otherwise clear a browser this export never touched.
    if (railGeneration.current === generation) {
      setSession(null);
      setLease({ state: "free" });
      setFrame(null);
    }
    return result;
  }, [consentToken, projectId, session, sessionId]);

  // THE SIGNAL DIES WITH THE PANE — see HostedBrowserBody for why this is its
  // own effect, keyed on the project alone.
  useEffect(() => {
    const key = browserPageToolsKey(projectId, "local");
    return () => useBrowserPageToolsStore.getState().clear(key);
  }, [projectId]);

  /**
   * Acquire or hand back, and say whether it landed.
   *
   * Returns a boolean because the TAKEOVER path needs the answer: a click that
   * did not get the lease must not then be forwarded as input, and the pane
   * has to know which. One function rather than two call sites, so that the
   * generation guard cannot be skipped by the newer one — a lease belongs to
   * ONE browser, and an answer arriving after the pane has moved to another
   * would show control of something nobody is watching.
   */
  const setLeaseAction = useCallback(
    async (action: "acquire" | "resume"): Promise<boolean> => {
      if (!session) return false;
      const generation = railGeneration.current;
      setError(null);
      try {
        const { lease: next } = await actOnLocalBrowserLease(
          { bootId: session.bootId, action, holder },
          consentToken,
        );
        // A lease belongs to ONE browser. If the pane moved on while this was
        // in flight — another project, or another browser in this one —
        // applying it would show control of something nobody is watching.
        if (railGeneration.current !== generation) return false;
        setLease(next);
        return true;
      } catch (err) {
        if (railGeneration.current !== generation) return false;
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [session, holder, consentToken],
  );

  useBrowserChatHandoff({
    projectId,
    sessionId,
    holding: consentGranted && holding,
    // Capture this browser's identity, without pane generation guards: the
    // handoff must still work after switching conversations or closing the pane.
    release: async (isCurrent) => {
      if (!session) return true;
      const mine = railGeneration.current;
      try {
        const outcome = await actOnLocalBrowserLease(
          { bootId: session.bootId, action: "resume", holder },
          consentToken,
        );
        if (isCurrent() && railGeneration.current === mine)
          setLease(outcome.lease);
        return true;
      } catch (cause) {
        if (cause instanceof LocalBrowserRequestError && cause.status === 404)
          return true;
        throw cause;
      }
    },
  });

  /**
   * Say somebody is watching, when no frame socket is saying it for us.
   *
   * The idle reap closes a browser nobody has used for ten minutes, and for
   * every other engine the frame socket's own heartbeat is the evidence. The
   * native surface has no socket — the page is a real view in this app's
   * window — so without this a person watching the agent work, and not holding
   * the lease, gets their browser closed while they are looking at it.
   *
   * Same conditions as the view itself: this pane visible, the document
   * visible, a grant in force. A pane behind the Logs tab is not watching, and
   * must not claim to be.
   */
  useEffect(() => {
    if (!session || !consentGranted) return;
    const bootId = session.bootId;
    const beat = () => {
      if (!activeRef.current) return;
      if (document.visibilityState !== "visible") return;
      void noteLocalBrowserWatch({ bootId }, consentToken).catch(() => {});
    };
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [native, session, consentGranted, consentToken]);

  // Keep the lease alive while somebody is holding it: it expires into
  // `parked` on purpose, and a person mid-login should not have to re-take a
  // browser they never let go of.
  useEffect(() => {
    if (!holding || !session) return;
    const timer = setInterval(() => {
      if (!activeRef.current || document.visibilityState !== "visible") return;
      void actOnLocalBrowserLease(
        { bootId: session.bootId, action: "heartbeat", holder },
        consentToken,
      ).catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [holding, session, holder, consentToken]);

  /**
   * Ask again while somebody else has it.
   *
   * The refusal that told this pane it does not have control arrives on the
   * frame socket — and NOTHING arrives when the other holder gives it back.
   * The frames were flowing the whole time, so there is no reconnection, no
   * `hello`, and no ack to carry the news. Without this the pane goes on
   * saying somebody else is driving, and withholds Take control (offered only
   * on a `free` lease) until the page is reloaded.
   *
   * Only while this pane is on screen and the document is visible: a rail
   * behind another tab is not waiting for anything.
   *
   * THROUGH `watch`, NOT `ensure`. `ensure` starts a browser when the one it
   * was asked about has gone — so a crash or a close under a waiting pane
   * would launch a Chromium nobody asked for, and hand back a different boot's
   * lease to a pane still looking at the old one. `watch` is keyed by this
   * `bootId`: it can only describe the browser this pane is actually watching,
   * and it answers 404 rather than starting anything when that browser is
   * gone. It is also the truer statement — somebody IS watching, which is what
   * keeps the idle sweep off a browser being waited for.
   */
  useEffect(() => {
    if (!session || !projectId || holding || lease.state === "free") return;
    // A REVOKED GRANT STOPS IT. Every call this makes carries the consent
    // token, and a pane whose grant has been withdrawn asking again every five
    // seconds is a pane arguing with a decision the person already made.
    if (!consentGranted) return;
    const bootId = session.bootId;
    const generation = railGeneration.current;
    let stopped = false;
    /** Which read is the LATEST, so a slow one cannot land on top of it. */
    let issued = 0;
    let applied = 0;
    const timer = setInterval(() => {
      if (!activeRef.current) return;
      if (document.visibilityState !== "visible") return;
      const serial = (issued += 1);
      void noteLocalBrowserWatch({ bootId }, consentToken)
        .then((next) => {
          if (stopped || railGeneration.current !== generation) return;
          // An older answer arriving after a newer one would put the lease
          // back to what it was BEFORE the newer read — and if that older
          // answer said `free`, the pane would offer Take control for a
          // browser the server is about to refuse.
          // The LATEST issued, not merely the latest applied: a newer request
          // that failed leaves `applied` where it was, and an older answer
          // arriving behind it would then be taken as current.
          if (serial !== issued || serial <= applied) return;
          applied = serial;
          if (!next.lease) return;
          setLease(next.lease);
          // Retract the message, and only it: the browser is available again.
          if (next.lease.state === "free") {
            setError((prev) => (prev === SOMEBODY_ELSE_HAS_IT ? null : prev));
          }
        })
        .catch((error: unknown) => {
          if (stopped || railGeneration.current !== generation) return;
          // A 404 FROM THIS ROUTE IS AN ANSWER, not a failure: it is keyed by
          // `bootId`, so it says that browser is gone — crashed, closed, or
          // reaped while somebody waited for it back. Retrying forever left
          // the pane saying somebody else was driving a browser that no longer
          // existed, and never offering to open a new one. Anything else is a
          // busy machine, and the next tick asks again.
          //
          // SERIALISED like the success path, for the same reason: an older
          // 404 landing behind a newer read that found the browser alive would
          // tear down a session that is still there.
          if (
            serial === issued &&
            serial > applied &&
            error instanceof LocalBrowserRequestError &&
            error.status === 404
          ) {
            applied = serial;
            stopped = true;
            setSession(null);
            setLease({ state: "free" });
            // AND THE PICTURE. It is of a browser that no longer exists, and
            // leaving it up under an "Open the browser" button is a pane
            // showing a page nobody can click on any more.
            setFrame(null);
            setError((prev) => (prev === SOMEBODY_ELSE_HAS_IT ? null : prev));
          }
        });
    }, LEASE_RECHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session, projectId, consentToken, consentGranted, holding, lease.state]);

  // One POST in flight, the rest queued and consecutive moves collapsed. A
  // drag otherwise fires a request per animation frame, and requests that
  // overtake each other put the pointer somewhere it never went.
  // One forwarder per HOLD, not per session. Whatever it has queued belonged
  // to the hold that queued it, so a hand-back, an expiry or a project switch
  // must retire it rather than let its tail arrive under whoever holds the
  // browser next — which is what the cleanup below does, and why the identity
  // includes `holding`.
  /**
   * Will the next batch go on the SOCKET?
   *
   * One predicate for two decisions that must agree: which transport the send
   * callback picks, and whether the forwarder has to serialize. Two spellings
   * of the same question drifted, and the drift was silent — concurrent POSTs
   * on a socket that had merely dropped.
   */
  const socketSendable = useCallback(
    () =>
      socketInputRef.current &&
      socketRef.current?.readyState === WebSocket.OPEN,
    [],
  );

  // One analytics event per pane, on the way out — see `session-summary`.
  // `local-native` is its OWN engine in the summary, not a flavour of
  // `electron`: the whole point of the wave is that the two are answerable
  // apart, and a report that called them the same thing could not say whether
  // the native surface helped.
  const engineRef = useRef<string>("local");
  engineRef.current = native ? "local-native" : (status?.runtime ?? "local");
  useEffect(
    () => () => captureBrowserPaneSessionSummary(engineRef.current),
    [],
  );

  /**
   * What this pane shows when there is no picture yet.
   *
   * `undefined` for the one case every engine shares — a session exists and the
   * first frame has not landed — which the surface answers itself.
   */
  const placeholder = (() => {
    if (!consentGranted) {
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-6">
          <div data-testid="rail-browser-unconsented">
            <LocalBrowserConsentGate
              onAllow={grantConsent}
              location="playground_browser"
            />
          </div>
        </div>
      );
    }
    if (status && !status.installed) {
      const { install: state } = status;
      return (
        <PaneMessage dashed>
          <span data-testid="rail-browser-needs-chromium">
            The agent needs a browser on this machine.
          </span>
          {state.status === "installing" ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Downloading Chromium
              {state.percent !== undefined ? ` — ${state.percent}%` : "…"}
            </span>
          ) : (
            <Button size="sm" onClick={() => void install()}>
              Install Chromium
            </Button>
          )}
          {state.status === "failed" ? (
            <span className="text-destructive">{state.error}</span>
          ) : null}
        </PaneMessage>
      );
    }
    if (!session) {
      const opening = busy;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          {opening ? (
            <div role="status" className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Opening browser…
            </div>
          ) : (
            <>
              <span data-testid="rail-browser-idle">
                {error
                  ? "Couldn't open the browser."
                  : "This browser is closed."}
              </span>
              <Button
                size="sm"
                disabled={!projectId}
                onClick={() => void start()}
              >
                {error ? "Try again" : "Open the browser"}
              </Button>
            </>
          )}
        </div>
      );
    }
    return undefined;
  })();

  // The stats overlay's flag, which the take-control bar used to own. Seeded
  // from the persisted key so somebody who set it in the console still gets
  // the overlay, exactly as the bar did.
  const [statsOpen, setStatsOpen] = useState(() => paneFrameStats.enabled());
  const onStatsToggle = useCallback((next: boolean) => {
    // The menu IS the flag: turning the overlay on has to START the recording,
    // not merely reveal a set of zeros.
    paneFrameStats.setEnabled(next);
    setStatsOpen(next);
  }, []);

  const control: PaneControl =
    lease.state === "free"
      ? "agent"
      : holding
        ? "you"
        : lease.holderKind === "script"
          ? "script"
          : "other";

  /**
   * The shell's transport, for this engine.
   *
   * Built here rather than in the shell because everything in it is
   * local-specific: the bootId that names this browser, the consent capability
   * every route needs, and a `resume` that is the lease's own verb. The shell
   * knows none of that and does not need to.
   */
  const bootId = session?.bootId ?? null;
  const shellTransport = useMemo(() => {
    if (!bootId) return null;
    return {
      readState: async () => {
        const state = await fetchLocalBrowserState({
          bootId,
          holder,
          consentToken,
        });
        if (projectId && state) {
          // Native Electron has no frame socket to publish tool changes.
          noteWebmcpStats(
            browserPageToolsKey(projectId, "local"),
            {
              webmcp: state.webmcp,
              tabs: { active: state.activeTabId ?? undefined },
            },
            bootId,
          );
        }
        return state;
      },
      sendCommand: (args: {
        command: BrowserPaneCommand;
        commandId?: string;
      }) =>
        sendLocalPaneCommand({
          bootId,
          holder,
          consentToken,
          command: args.command,
          ...(args.commandId ? { commandId: args.commandId } : {}),
        }),
      reportViewport: (size: { width: number; height: number }) =>
        reportLocalPaneViewport({
          bootId,
          consentToken,
          ...size,
          policy: "followPane",
        }),
      // THE PANE'S OWN lease action, not a bare call: it applies the answer to
      // this body's `lease` and drops one that arrived after the pane moved to
      // another browser. A resume that only reached the server would leave the
      // shell saying "You have it" over a browser the agent had already
      // resumed, until the next poll caught up.
      resume: async () => {
        // The boolean is for the takeover path, which must not deliver input
        // it did not get the lease for. A resume has nothing to gate: it
        // either handed back or reported its own error, and the shell's next
        // reconcile says which.
        await setLeaseAction("resume");
      },
    };
  }, [bootId, holder, consentToken, setLeaseAction, projectId]);

  // Native views cannot be scaled by the renderer's CSS like streamed frames.
  // Fit the actual page to its slot even when the workspace chrome is disabled.
  const reportNativeViewport = useCallback(
    (size: { width: number; height: number }) => {
      if (!bootId) return;
      void reportLocalPaneViewport({
        bootId,
        consentToken,
        ...size,
        policy: "followPane",
      });
    },
    [bootId, consentToken],
  );

  const shell = useBrowserSession({
    transport: shellTransport,
    sessionKey: JSON.stringify([projectId, sessionId, bootId]),
    holderId: holder,
    active,
  });

  const forwarder = useMemo(() => {
    if (!active || !session || !holding) return null;
    const bootId = session.bootId;
    const tabId = shell.state.activeTabId ?? undefined;
    return createInputForwarder(
      (events, seq) => {
        if (!activeRef.current || document.visibilityState !== "visible")
          return;
        paneFrameStats.noteInputSent(frameSeqRef.current, seq);
        if (socketSendable()) {
          socketRef.current!.send(
            JSON.stringify({ type: "input", seq, events, tabId }),
          );
          return;
        }
        return sendLocalBrowserInput(
          { bootId, holder, events, tabId },
          consentToken,
        );
      },
      // The predicate has to match the TRANSPORT the callback actually
      // chooses, not merely the capability: the send falls back to POST
      // whenever the socket is not open, and a `serialize` that only read the
      // flag let two POSTs travel at once — an unordered drag lands where
      // nobody aimed, and an unordered press/release leaves a button held.
      { serialize: () => !socketSendable() },
    );
  }, [
    session,
    holding,
    holder,
    consentToken,
    socketSendable,
    shell.state.activeTabId,
    active,
  ]);
  useEffect(() => () => forwarder?.cancel(), [forwarder]);

  const send = useCallback(
    (events: BrowserInputEvent[]) => {
      if (!forwarder || !holding || events.length === 0) return;
      forwarder.push(events);
    },
    [forwarder, holding],
  );

  // The frame socket. Re-opened when the browser changes; closed on unmount,
  // which is what tells the server to stop encoding JPEGs nobody is watching.
  useEffect(() => {
    // NOT ON THE NATIVE SURFACE. There is nothing to watch: the page is a real
    // view in the app's own window, and opening this socket would make the
    // engine encode JPEGs at 30 fps that no pane ever draws.
    setFrame(null);
    if (!session || !projectId || native || !shell.state.activeTabId) return;
    let closed = false;
    let stream: { close(): void } | null = null;
    /**
     * This attempt's socket, captured for the cleanup.
     *
     * Compared by IDENTITY on teardown so a reconnect that already replaced
     * the ref is not cleared by the closure of the connection it replaced —
     * which would leave the pane POSTing input while a perfectly good socket
     * was open.
     */
    let openedSocket: WebSocket | null = null;
    /** Decodes the binary pixel path; null until the socket is open. */
    let wire: ReturnType<typeof createFrameWireReader> | null = null;
    /** The last bitmap this socket produced, so teardown can release it. */
    let lastBitmap: ImageBitmap | undefined;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const { nonce } = await mintLocalBrowserFrameNonce(
          projectId,
          consentToken,
        );
        if (closed) return;
        const opened = openLocalBrowserFrameStream({
          bootId: session.bootId,
          tabId: shell.state.activeTabId ?? undefined,
          holder,
          nonce,
          // Worth it even on loopback, where base64 costs a memcpy rather than
          // a network hop: it means the hosted path's decoder runs on every
          // local session instead of only on staging.
          wire: "binary",
        });
        stream = opened;
        wire = createFrameWireReader({
          onFrame: (decoded) => {
            if (closed) return;
            paneFrameStats.noteTransport("jpeg-binary");
            paneFrameStats.noteFrameArrived({ bytes: decoded.bytes });
            frameSeqRef.current = decoded.seq;
            // React can coalesce two `setFrame` calls into one render, and the
            // surface only ever releases a frame it PAINTED — so a picture
            // superseded before the commit has nobody to free it.
            lastBitmap?.close();
            lastBitmap = decoded.bitmap;
            setFrame({
              bitmap: decoded.bitmap,
              decodeMs: decoded.decodeMs,
              deviceWidth: decoded.deviceWidth,
              deviceHeight: decoded.deviceHeight,
              scale: decoded.scale,
              ts: decoded.relayTs,
              relayTs: decoded.relayTs,
              seq: decoded.seq,
            });
          },
          onHeartbeat: (daemon) => {
            if (daemon) paneFrameStats.noteDaemonStats(daemon as never);
            noteWebmcpStats(
              browserPageToolsKey(projectId, "local"),
              daemon as never,
              session.bootId,
            );
          },
          onFatal: () => {
            // A reader that has lost its place in a byte stream can never find
            // it again, so the connection goes rather than the record.
            opened.close();
          },
        });
        openedSocket = opened.socket;
        socketRef.current = opened.socket;
        socketInputRef.current = false;
        paneFrameStats.noteTransport("jpeg-json");
        opened.socket.onmessage = (event) => {
          // Bytes for pixels, text for control, on one socket — see the hosted
          // pane's twin.
          if (typeof event.data !== "string") {
            wire?.push(event.data as ArrayBuffer);
            return;
          }
          try {
            const raw = String(event.data);
            const parsed = JSON.parse(raw) as {
              type?: string;
              frame?: PaneFrame;
              t?: number;
              framesIn?: number;
              framesOut?: number;
              bytes?: number;
              dropped?: number;
              subscribers?: number;
              daemon?: Record<string, unknown>;
            };
            if (parsed.type === "hello") {
              const features = Array.isArray(
                (parsed as { features?: unknown }).features,
              )
                ? ((parsed as { features: unknown[] }).features as unknown[])
                : [];
              socketInputRef.current = features.includes("input");
              return;
            }
            if (parsed.type === "input_ack") {
              const ack = parsed as unknown as {
                seq?: number;
                refused?: string;
              };
              if (typeof ack.seq === "number") {
                paneFrameStats.noteInputAck(ack.seq);
              }
              // A REFUSAL IS THE SERVER SAYING THIS PANE DOES NOT HAVE
              // CONTROL. Recording only the latency left the pane believing it
              // did — still forwarding keys and clicks into a page that
              // discards every one, with nothing on screen to say why, until
              // some later read happened to notice.
              if (
                ack.refused === "lease_held" ||
                ack.refused === "lease_parked"
              ) {
                setLease({ state: "held" });
                setError(SOMEBODY_ELSE_HAS_IT);
              } else if (ack.refused === "lease_required") {
                setLease({ state: "free" });
              }
              return;
            }
            if (parsed.type === "pong") {
              if (typeof parsed.t === "number") {
                paneFrameStats.noteRtt(Date.now() - parsed.t);
              }
              return;
            }
            if (parsed.type === "stats") {
              // The page's tools, as a change signal. Synthesized by the local
              // relay (there is no heartbeat in-process to ride), so the Tools
              // pane is live on the engine a developer debugs against too.
              noteWebmcpStats(
                browserPageToolsKey(projectId, "local"),
                parsed.daemon as never,
                session.bootId,
              );
              paneFrameStats.noteRelayStats({
                framesIn: parsed.framesIn ?? 0,
                ...(parsed.framesOut !== undefined
                  ? { framesOut: parsed.framesOut }
                  : {}),
                bytes: parsed.bytes ?? 0,
                dropped: parsed.dropped ?? 0,
                subscribers: parsed.subscribers ?? 0,
                ...(parsed.daemon ? { daemon: parsed.daemon as never } : {}),
              });
              return;
            }
            if (parsed.type === "frame" && parsed.frame) {
              paneFrameStats.noteFrameArrived({ bytes: raw.length });
              frameSeqRef.current = parsed.frame.seq;
              setFrame(parsed.frame);
            }
          } catch {
            // Not our protocol.
          }
        };
        opened.socket.onclose = (event) => {
          if (closed) return;
          if (event.code === CLOSE_LEASE_HELD) {
            // Somebody else holds the browser — including a handoff that
            // happened while this socket was open, which the daemon revokes
            // mid-stream. Not a terminal state: the view has to come back when
            // they hand it back, so keep asking rather than latching an error
            // nothing will ever clear.
            setError(
              "Somebody else has taken control of this browser. The view will resume when they hand it back.",
            );
            setFrame(null);
            retry = setTimeout(() => {
              if (!closed) setStreamAttempt((n) => n + 1);
            }, 3_000);
            return;
          }
          if (event.code === CLOSE_UNAUTHORIZED) {
            // TERMINAL, and told apart from the refusal above by its own code.
            // The nonce is spent or consent moved underneath us; retrying on a
            // timer would burn credentials against the same answer forever and
            // report it as somebody else's handoff the whole time.
            setError(
              event.reason ||
                "This machine's authorization changed. Reopen the pane to watch again.",
            );
            setFrame(null);
          }
        };
        opened.socket.onopen = () => {
          // Whatever refused the last attempt is over.
          setError(null);
        };
        // Only while somebody is actually LOOKING: the document being visible
        // is not enough, because this pane stays mounted behind the Logs tab.
        // Watching is what defers the idle reap, so a pane nobody is looking
        // at must stop claiming otherwise.
        heartbeat = setInterval(() => {
          if (!activeRef.current) return;
          if (document.visibilityState !== "visible") return;
          if (opened.socket.readyState !== WebSocket.OPEN) return;
          opened.socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
        }, 20_000);
      } catch (err) {
        if (!closed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      closed = true;
      wire?.close();
      // The pane releases each bitmap as the next replaces it; the LAST one
      // has no successor.
      lastBitmap?.close();
      if (heartbeat) clearInterval(heartbeat);
      if (retry) clearTimeout(retry);
      if (socketRef.current === openedSocket) {
        socketRef.current = null;
        socketInputRef.current = false;
      }
      stream?.close();
    };
  }, [
    session,
    projectId,
    consentToken,
    holder,
    streamAttempt,
    native,
    shell.state.activeTabId,
    active,
  ]);

  /**
   * Take the browser, then deliver the interaction that asked for it.
   *
   * THE LEASE ENDPOINT, not a pane command. `pane-command` acquires as a side
   * effect of doing something, which is right for a navigation and wrong here:
   * a person who clicked into the page has asked for exactly that click, and
   * borrowing some other verb to get the lease would perform an action nobody
   * requested. `acquire` is the verb whose whole meaning is "this is mine now".
   *
   * The ordinary input path is untouched. Once the lease is ours, `holding`
   * flips and every later event goes through the batched forwarder over the
   * socket, as it always has; this runs once, for the interaction that arrived
   * before there was a lease to send it under.
   */
  useEffect(() => {
    if (!native || shell.state.seq === 0) return;
    const current = shell.state.control;
    setLease(
      current.kind === "agent"
        ? { state: "free" }
        : {
            state: current.parked ? "parked" : "held",
            holder: current.holder,
            holderKind: current.kind === "script" ? "script" : "human",
          },
    );
  }, [native, workspaceEnabled, shell.state.seq, shell.state.control]);

  const [takeoverNotice, setTakeoverNotice] = useState<string | null>(null);
  const takingRef = useRef(false);
  const takeoverIdentityRef = useRef(bootId);
  takeoverIdentityRef.current = bootId;
  const takeover = useCallback(
    async (events: BrowserInputEvent[]) => {
      if (!bootId || takingRef.current) return;
      const anchor = paneInteractionAnchor(shell.state, bootId);
      takingRef.current = true;
      try {
        if (
          !(await setLeaseAction("acquire")) ||
          takeoverIdentityRef.current !== bootId
        )
          return;
        if (!anchor) {
          setTakeoverNotice(TAKEOVER_RETRY_NOTICE);
          return;
        }
        await sendLocalBrowserInput(
          { bootId, holder, events, anchor },
          consentToken,
        );
        setTakeoverNotice(null);
      } catch {
        setTakeoverNotice(TAKEOVER_RETRY_NOTICE);
      } finally {
        takingRef.current = false;
      }
    },
    [bootId, holder, consentToken, setLeaseAction, shell.state],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <BrowserShell
          enabled={true}
          state={shell.state}
          holderId={holder}
          // THIS engine's lease, not the shell's polled copy: the local body
          // learns about its own acquire the moment it lands, and the shell's
          // reconcile is a beat behind. @see BrowserShellProps.control
          holding={holding}
          control={{
            kind:
              lease.state === "free"
                ? "agent"
                : lease.holderKind === "script"
                  ? "script"
                  : "human",
            ...(lease.state !== "free" && lease.holder
              ? { holder: lease.holder }
              : {}),
            ...(lease.state === "parked" ? { parked: true } : {}),
          }}
          onCommand={shell.run}
          // The shell owns the picture's SIZE, so it is the shell that
          // measures. @see BrowserShellProps.onViewportMeasured
          onViewportMeasured={!native ? shell.reportViewport : undefined}
          // Not just "is there a browser": an engine too old to answer pane
          // commands has a perfectly real session, and controls that look live
          // and swallow every click read as broken rather than old.
          ready={!!session && shell.supported}
          // The shell's own notice wins over the pane's — a dropped takeover
          // click is about this interaction, while the pane's notices are
          // about the stream — and the pane's shows through when there is no
          // shell notice to display.
          notice={takeoverNotice ?? shell.notice}
          error={error ?? shell.error}
          // The ENGINE's blocked states — no consent, no Chromium, a browser
          // that has gone — replace the page area entirely. @see the prop.
          {...(placeholder ? { placeholder } : {})}
          trailing={
            <>
              {hostId ? <BrowserSettingsButton hostId={hostId} /> : null}
              <PaneSettingsMenu
                statsOpen={statsOpen}
                onToggleStats={onStatsToggle}
              >
                {session && sessionId ? (
                  <BrowserProfileSaveButton
                    projectId={projectId ?? ""}
                    exportArchive={exportProfile}
                    disabled={busy}
                  />
                ) : null}
              </PaneSettingsMenu>
            </>
          }
        >
          {native ? (
            <ElectronNativeBody
              consentToken={consentToken}
              session={session}
              onViewportSize={reportNativeViewport}
              holder={holder}
              control={control}
              holding={holding}
              consentGranted={consentGranted}
              active={active}
              engine="local-native"
              chrome="none"
            />
          ) : (
            <BrowserPaneSurface
              key={shell.state.activeTabId}
              // Gated as well as cleared: a frame that lands in the same tick as
              // the revocation must not be the one that gets painted.
              frame={consentGranted ? frame : null}
              authority={{ kind: "lease", holding }}
              control={control}
              // NO take-control button. Using the browser is what takes it now,
              // and the shell's second row already says who is driving.
              chrome="none"
              // The shell's menu owns this now; the surface draws it.
              statsOpen={statsOpen}
              onInput={send}
              onTakeoverInput={takeover}
              onTakeControl={
                !workspaceEnabled &&
                session &&
                !holding &&
                lease.state === "free"
                  ? () => void setLeaseAction("acquire")
                  : undefined
              }
              onHandBack={
                !workspaceEnabled && session && holding
                  ? () => void setLeaseAction("resume")
                  : undefined
              }
              active={active}
              engine={status?.runtime ?? "local"}
            />
          )}
        </BrowserShell>
      </div>
    </div>
  );
}

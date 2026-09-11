import { useViewportReporter } from "../browser-pane/use-viewport-reporter";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  EMPTY_BROWSER_SESSION_STATE,
  isHeldBy,
  reduceBrowserState,
  type BrowserConnectionState,
  type BrowserSessionState,
  type BrowserStateSnapshot,
} from "../../../../shared/browser-session-state";
import {
  TAKEOVER_RETRY_NOTICE,
  takeoverRefusedNotice,
  type BrowserPaneCommand,
} from "../../../../shared/browser-pane-command";
import type { PaneCommandResult } from "../../../../shared/browser-pane-wire";
import type { SessionViewport } from "../../../../shared/browser-viewport";

/**
 * The browser shell's state, on whichever engine happens to be underneath.
 *
 * ENGINE-AGNOSTIC BY CONSTRUCTION: everything transport-shaped arrives as
 * `transport`, so the local engine's consent-gated POSTs, the hosted engine's
 * token-minting fetches and Electron's in-process calls all reach the same
 * hook. The alternative — a hook per engine — is three copies of the polling,
 * the coalescing and the notice vocabulary, which is three chances for the
 * desktop app's tab strip to disagree with the web app's about what a refusal
 * means.
 *
 * POLLED rather than pushed. There is a socket that already carries some of
 * this — the frame stream's heartbeat has a truncated tab list — but it is not
 * complete, it does not exist on Electron at all, and a shell that worked
 * differently depending on which transport its engine happened to have is a
 * shell with three behaviours. One poll, every engine, and the frame socket
 * goes back to carrying frames.
 */

export interface BrowserSessionTransport {
  /**
   * Read the whole browser, or null when it cannot be read.
   *
   * Null covers three different things on purpose — no session yet, somebody
   * else holds it, an engine too old to answer — because the shell's response
   * to all three is the same: keep what you last saw. @see decodePaneState
   */
  readState: () => Promise<BrowserStateSnapshot | null>;
  sendCommand: (args: {
    command: BrowserPaneCommand;
    commandId?: string;
  }) => Promise<PaneCommandResult>;
  /** Report a panel measurement. Absent on an engine that cannot resize. */
  reportViewport?: (size: {
    width: number;
    height: number;
  }) => Promise<SessionViewport | null>;
  /** Hand the browser back so the agent can continue. */
  resume?: () => Promise<void>;
}

export interface UseBrowserSessionArgs {
  transport: BrowserSessionTransport | null;
  /** Reset tab metadata and pending work when the displayed browser changes. */
  sessionKey?: string | null;
  /** This pane's lease identity. */
  holderId: string | null;
  /**
   * Is the pane on screen?
   *
   * A hidden pane stops polling entirely. The state it holds is still correct
   * enough to draw the moment it comes back — and on the hosted engine every
   * poll is a request against a metered box that nobody is looking at.
   */
  active: boolean;
  /** How often to reconcile. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 2_000;
export interface BrowserSessionHandle {
  state: BrowserSessionState;
  /** True while this pane holds the browser. */
  holding: boolean;
  /**
   * Can this engine answer pane commands at all?
   *
   * Latched false by the first refusal rather than read up front, because
   * `readState` cannot tell us: it answers null for an engine too old to
   * speak, for a browser somebody else holds and for one that has not started
   * yet, and collapsing those three is exactly what keeps the poll from
   * flickering. @see BrowserSessionTransport.readState
   *
   * The shell renders its controls inert on false. Without that a browser
   * running an older daemon draws a full tab strip and address field that
   * swallow every click in silence, which reads as a broken browser rather
   * than an old one.
   */
  supported: boolean;
  /** Run one command, taking the browser first if it is free. */
  run: (command: BrowserPaneCommand) => void;
  /** Hand it back, then let the agent continue from a fresh look. */
  resume: () => void;
  resuming: boolean;
  /** Report a panel measurement, coalesced by the session barrier upstream. */
  reportViewport: (size: { width: number; height: number }) => void;
  /** A transient one-liner over the page. Clears itself. */
  notice: string | null;
  error: string | null;
}

export function useBrowserSession({
  transport,
  sessionKey,
  holderId,
  active,
  pollMs = DEFAULT_POLL_MS,
}: UseBrowserSessionArgs): BrowserSessionHandle {
  const [state, dispatch] = useReducer(
    reduceBrowserState,
    EMPTY_BROWSER_SESSION_STATE,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  // Read through a ref inside the poll and the command path, so neither
  // restarts when the transport identity changes on a re-render — which it
  // does on every render for a caller that builds it inline, and a poll that
  // restarted that often would never complete one.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const identity = useRef({ key: sessionKey, generation: 0 });
  if (identity.current.key !== sessionKey) {
    identity.current = {
      key: sessionKey,
      generation: identity.current.generation + 1,
    };
  }

  useLayoutEffect(() => {
    dispatch({ type: "snapshot", snapshot: EMPTY_BROWSER_SESSION_STATE });
    setNotice(null);
    setError(null);
    setResuming(false);
    setUnsupported(false);
  }, [sessionKey]);

  const setConnection = useCallback((connection: BrowserConnectionState) => {
    dispatch({ type: "connection_changed", connection });
  }, []);

  /**
   * A new transport is a new browser, and possibly a newer engine.
   *
   * Without this the refusal latched by one session outlives it: close a
   * browser running an old daemon, start one that speaks the shell's language,
   * and its controls would come up dead. Keyed on the same `transport` the
   * poll restarts on, so the two agree on when a session became a new one.
   */
  useEffect(() => {
    setUnsupported(false);
  }, [transport]);

  useEffect(() => {
    if (!active || !transport) {
      setConnection("closed");
      return;
    }
    const generation = identity.current.generation;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const snapshot = await transportRef.current
        ?.readState()
        .catch(() => null);
      if (cancelled || generation !== identity.current.generation) return;
      if (snapshot) {
        dispatch({ type: "snapshot", snapshot });
        setConnection("live");
      } else {
        // NOT `closed`. A read that failed is a read that failed; the browser
        // may be perfectly alive and held by somebody else, and a shell that
        // announced a dead browser every time a poll lost a race would spend
        // its life flickering.
        setConnection("reconnecting");
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), pollMs);
    };
    setConnection("connecting");
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, transport, sessionKey, pollMs, setConnection]);

  /** Clear a notice after a moment, and never leave a stale one on screen. */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = useCallback((command: BrowserPaneCommand) => {
    const current = transportRef.current;
    if (!current) return;
    const generation = identity.current.generation;
    void (async () => {
      const outcome = await current.sendCommand({ command });
      if (
        identity.current.generation !== generation ||
        transportRef.current !== current
      )
        return;
      if (outcome.ok) {
        setError(null);
        // Reconcile immediately rather than waiting out the poll: a person
        // who clicked Back expects the address to move now, and two seconds
        // of a stale address bar reads as a click that did nothing.
        const snapshot = await current.readState().catch(() => null);
        if (
          snapshot &&
          identity.current.generation === generation &&
          transportRef.current === current
        ) {
          dispatch({ type: "snapshot", snapshot });
        }
        return;
      }
      switch (outcome.reason) {
        case "lease_held":
          setNotice(takeoverRefusedNotice(outcome.holder ?? { kind: "human" }));
          return;
        case "page_changed":
          setNotice(TAKEOVER_RETRY_NOTICE);
          return;
        case "no_session":
          setError("This browser is no longer running.");
          return;
        case "unsupported":
          // No message, because the latch IS the message: the controls this
          // click came from go inert on the same render, which says "this
          // browser cannot do that" in the place the person is already
          // looking. A banner would say it twice.
          setUnsupported(true);
          return;
        default:
          setError(outcome.detail ?? "The browser did not accept that.");
      }
    })();
  }, []);

  const resume = useCallback(() => {
    const current = transportRef.current;
    if (!current?.resume) return;
    const generation = identity.current.generation;
    const isCurrent = () =>
      identity.current.generation === generation &&
      transportRef.current === current;
    setResuming(true);
    void current
      .resume()
      .catch(() => {
        if (isCurrent()) setError("Could not hand the browser back.");
      })
      .finally(async () => {
        if (!isCurrent()) return;
        setResuming(false);
        const snapshot = await current.readState().catch(() => null);
        if (snapshot && isCurrent()) dispatch({ type: "snapshot", snapshot });
      });
  }, []);

  /**
   * Report a panel measurement, coalesced BEFORE the network.
   *
   * The barrier on the far side already coalesces — that is what stops a
   * resize landing mid-action — but it coalesces requests that have already
   * been sent. A `ResizeObserver` fires once per animation frame while
   * somebody drags a divider, so without this the client posts sixty requests
   * a second, each of which is an authorized fetch and, on the hosted engine,
   * a round trip against a metered box. Coalescing here costs one timer and
   * removes fifty-nine of them.
   *
   * The LAST measurement wins, not the first: a drag's earlier sizes are
   * places the divider passed through, not places anybody left it.
   */
  const reportViewport = useViewportReporter(
    (size) =>
      active ? transportRef.current?.reportViewport?.(size) : undefined,
    useMemo(
      () => ({ holderId, sessionKey, active }),
      [holderId, sessionKey, active],
    ),
  );

  const holding = useMemo(() => isHeldBy(state, holderId), [state, holderId]);

  return {
    state,
    holding,
    supported: !unsupported,
    run,
    resume,
    resuming,
    reportViewport,
    notice,
    error,
  };
}

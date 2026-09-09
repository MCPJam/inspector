import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
/**
 * How long a panel measurement waits for a quieter one to replace it.
 *
 * Shorter than the barrier's own debounce on the far side, deliberately: this
 * one is only removing requests that would be coalesced anyway, and making it
 * longer would add latency to the common case — one resize, nobody dragging —
 * for no saving at all.
 */
const RESIZE_COALESCE_MS = 80;

export interface BrowserSessionHandle {
  state: BrowserSessionState;
  /** True while this pane holds the browser. */
  holding: boolean;
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

  // Read through a ref inside the poll and the command path, so neither
  // restarts when the transport identity changes on a re-render — which it
  // does on every render for a caller that builds it inline, and a poll that
  // restarted that often would never complete one.
  const transportRef = useRef(transport);
  transportRef.current = transport;

  const setConnection = useCallback((connection: BrowserConnectionState) => {
    dispatch({ type: "connection_changed", connection });
  }, []);

  useEffect(() => {
    if (!active || !transport) {
      setConnection("closed");
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const snapshot = await transportRef.current?.readState().catch(() => null);
      if (cancelled) return;
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
  }, [active, transport, pollMs, setConnection]);

  /** Clear a notice after a moment, and never leave a stale one on screen. */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = useCallback(
    (command: BrowserPaneCommand) => {
      const current = transportRef.current;
      if (!current) return;
      void (async () => {
        const outcome = await current.sendCommand({ command });
        if (outcome.ok) {
          setError(null);
          // Reconcile immediately rather than waiting out the poll: a person
          // who clicked Back expects the address to move now, and two seconds
          // of a stale address bar reads as a click that did nothing.
          const snapshot = await current.readState().catch(() => null);
          if (snapshot) dispatch({ type: "snapshot", snapshot });
          return;
        }
        switch (outcome.reason) {
          case "lease_held":
            setNotice(
              takeoverRefusedNotice(outcome.holder ?? { kind: "human" }),
            );
            return;
          case "page_changed":
            setNotice(TAKEOVER_RETRY_NOTICE);
            return;
          case "no_session":
            setError("This browser is no longer running.");
            return;
          case "unsupported":
            // Silent. The controls are already inert on an engine that cannot
            // answer, so a message here would explain something the person
            // cannot see the effect of.
            return;
          default:
            setError(outcome.detail ?? "The browser did not accept that.");
        }
      })();
    },
    [],
  );

  const resume = useCallback(() => {
    const current = transportRef.current;
    if (!current?.resume) return;
    setResuming(true);
    void current
      .resume()
      .catch(() => setError("Could not hand the browser back."))
      .finally(async () => {
        setResuming(false);
        const snapshot = await transportRef.current
          ?.readState()
          .catch(() => null);
        if (snapshot) dispatch({ type: "snapshot", snapshot });
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
  const pendingSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeTimerRef = useRef<number | undefined>(undefined);
  const sentSizeRef = useRef<{ width: number; height: number } | null>(null);
  useEffect(
    () => () => {
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current);
      }
    },
    [],
  );
  const reportViewport = useCallback(
    (size: { width: number; height: number }) => {
      // Rounded before comparing, because CSS layout is fractional and a
      // sub-pixel wobble is not a resize. The server rounds too; agreeing here
      // is what makes "the size did not change" mean the same on both sides.
      const next = {
        width: Math.round(size.width),
        height: Math.round(size.height),
      };
      const sent = sentSizeRef.current;
      if (sent && sent.width === next.width && sent.height === next.height) {
        return;
      }
      pendingSizeRef.current = next;
      if (resizeTimerRef.current !== undefined) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = undefined;
        const pending = pendingSizeRef.current;
        pendingSizeRef.current = null;
        if (!pending) return;
        sentSizeRef.current = pending;
        // Fire and forget: the far side answers with the size it settled on,
        // and the next poll carries that back, so there is nothing here worth
        // awaiting.
        void transportRef.current?.reportViewport?.(pending).catch(() => {
          // A failed report must not stick: the next measurement has to be
          // sent even if it is the same size, or a transient failure freezes
          // the session at a stale one.
          sentSizeRef.current = null;
        });
      }, RESIZE_COALESCE_MS);
    },
    [],
  );

  const holding = useMemo(
    () => isHeldBy(state, holderId),
    [state, holderId],
  );

  return {
    state,
    holding,
    run,
    resume,
    resuming,
    reportViewport,
    notice,
    error,
  };
}

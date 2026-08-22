import { useEffect, useRef, useState } from "react";
import { validateHostedServer } from "@/lib/apis/web/servers-api";
import { BootstrapNotReadyError } from "@/lib/app-ready";

/**
 * Whether this session can actually reach a server, as opposed to whether the
 * bootstrap payload listed it.
 *
 * "checking" is the pre-answer state. It is deliberately not treated as
 * reachable: the reported failure was a tester spending a whole session on a
 * scenario whose only server never connected, so an unanswered probe must not
 * read as a working session.
 */
export type ScenarioServerReachability =
  | "checking"
  | "reachable"
  | "unreachable";

/**
 * Attempts while the request builder is still refusing to build. `/redeem`
 * resolves before `useApiContext` has published this scenario's project and
 * server ids, so the first probes lose that race. These cost nothing — the
 * builder throws synchronously, without a round trip — so they are counted
 * separately from attempts that actually reached the server.
 *
 * Running out of them is not a verdict: no request was ever made, so the
 * server is left reported as reachable rather than branded on evidence that
 * does not exist.
 */
const BOOTSTRAP_ATTEMPTS = 6;
const BOOTSTRAP_RETRY_DELAY_MS = 300;

/**
 * Attempts that reach the wire. Calling a healthy server unreachable is not a
 * cosmetic error: the verdict is final for the session (nothing re-probes), it
 * drops the server from the turn, and it tells the tester something false. One
 * retry covers the blips that would otherwise do that — a 502, a dropped
 * connection, a server slow to wake — without making a genuinely dead server
 * take a minute to report. A lost response is the exception; see
 * `ProbeTimeoutError`.
 */
const PROBE_ATTEMPTS = 2;
const PROBE_RETRY_DELAY_MS = 500;

/**
 * Client-side deadline. The route bounds its own handler, which does not bound
 * this promise: a dropped connection or a proxy that never answers would leave
 * the probe pending forever, and "checking" holds the composer shut. Set above
 * the server's connect timeout so this only fires when the response itself is
 * lost.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * A probe that outlived the deadline. Distinct from the wire failures around
 * it because it is not retried: the deadline sits above the route's own connect
 * timeout, so reaching it means the response was lost rather than that the
 * server was slow, and a second full wait buys the same answer while the
 * composer stays shut for twice as long.
 */
class ProbeTimeoutError extends Error {
  constructor() {
    super(`Probe timed out after ${PROBE_TIMEOUT_MS}ms`);
    this.name = "ProbeTimeoutError";
  }
}

export interface ScenarioServerReachabilityInput {
  serverId: string;
  serverName: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withProbeTimeout<T>(
  promise: Promise<T>,
  controller: AbortController
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      // Abort as well as reject. Rejecting only frees this caller — the
      // request it gave up on would keep its connection open on the server for
      // the rest of the route's connect timeout.
      controller.abort();
      reject(new ProbeTimeoutError());
    }, PROBE_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

/**
 * Connects to each of a tester session's servers up front and reports which
 * ones answered.
 *
 * Nothing else in the guest runtime does this. `/api/web/scenarios/redeem` is a
 * config fetch that never touches the servers it lists, and the first real
 * connection attempt happens inside a chat turn — so an unreachable server was
 * invisible until the tester had already spent the session on it, or produced
 * a generic failed turn with no attribution.
 *
 * `/api/web/servers/validate` is the same connect-and-list-tools hop the chat
 * turn will make, so a pass here means the turn's connection will work for the
 * same reasons, and a failure here is the failure the turn would have hit.
 *
 * The caller decides which servers to probe: servers whose authorization is
 * still unresolved belong to the OAuth gate, which verifies them with this same
 * endpoint. Probing those here would double-connect and report "unreachable"
 * for a server that is merely waiting for consent.
 *
 * `sessionKey` identifies the redeemed session these verdicts belong to. Every
 * verdict is scoped to it, because a verdict says "this session reached this
 * server", not "this server is up".
 */
export function useScenarioServerReachability(
  servers: ScenarioServerReachabilityInput[],
  enabled: boolean,
  sessionKey: string | null
): Record<string, ScenarioServerReachability> {
  const [reachabilityByServerId, setReachabilityByServerId] = useState<
    Record<string, ScenarioServerReachability>
  >({});
  const probedServerIdsRef = useRef<Set<string>>(new Set());
  const probedSessionKeyRef = useRef<string | null>(sessionKey);
  const isUnmountedRef = useRef(false);
  const inFlightProbesRef = useRef<Set<AbortController>>(new Set());

  // A tester opening a different scenario does not remount the page —
  // `ScenarioChatPage` swaps its session in place — so the previous session's
  // probe state has to be dropped here. Two scenarios in one project can list
  // the same server id, and keeping the old verdict would both skip probing it
  // and show an answer this session never got. Reset during render so no frame
  // is painted from the previous session's verdicts.
  if (probedSessionKeyRef.current !== sessionKey) {
    probedSessionKeyRef.current = sessionKey;
    probedServerIdsRef.current = new Set();
    setReachabilityByServerId((previous) =>
      Object.keys(previous).length === 0 ? previous : {}
    );
  }

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      // A probe that outlives the page still holds a connection open on the
      // server for the rest of its connect timeout, and nobody is left to read
      // its answer.
      for (const controller of inFlightProbesRef.current) {
        controller.abort();
      }
      inFlightProbesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const probeSessionKey = sessionKey;

    for (const server of servers) {
      if (probedServerIdsRef.current.has(server.serverId)) continue;
      probedServerIdsRef.current.add(server.serverId);

      setReachabilityByServerId((previous) =>
        previous[server.serverId]
          ? previous
          : { ...previous, [server.serverId]: "checking" }
      );

      void (async () => {
        let reachability: ScenarioServerReachability = "unreachable";
        let bootstrapAttempts = 0;
        let probeAttempts = 0;

        for (;;) {
          const controller = new AbortController();
          inFlightProbesRef.current.add(controller);
          try {
            await withProbeTimeout(
              validateHostedServer(
                server.serverId,
                undefined,
                undefined,
                undefined,
                controller.signal
              ),
              controller
            );
            reachability = "reachable";
            break;
          } catch (error) {
            // Nobody is left to read this verdict, and the abort that tore the
            // probe down says nothing about the server.
            if (isUnmountedRef.current) return;

            const isBootstrap = error instanceof BootstrapNotReadyError;
            const exhausted =
              error instanceof ProbeTimeoutError ||
              (isBootstrap
                ? ++bootstrapAttempts >= BOOTSTRAP_ATTEMPTS
                : ++probeAttempts >= PROBE_ATTEMPTS);

            if (exhausted) {
              if (isBootstrap) {
                // Nothing ever reached the wire, so there is no evidence about
                // this server either way. Reporting it unreachable would show
                // the tester a failure this session never observed and drop a
                // healthy server from the turn — the same lie this hook exists
                // to remove, arriving from the other direction. Let the turn
                // make its own attempt and report its own failure.
                reachability = "reachable";
              }
              // Transport details are never shown to a tester — they followed a
              // link and cannot act on an SSE status code. The banner names the
              // server; the detail stays here for whoever debugs it.
              console.error(
                isBootstrap
                  ? "[useScenarioServerReachability] never got to probe the server"
                  : "[useScenarioServerReachability] server did not connect",
                {
                  serverId: server.serverId,
                  serverName: server.serverName,
                  error,
                }
              );
              break;
            }

            await delay(
              isBootstrap ? BOOTSTRAP_RETRY_DELAY_MS : PROBE_RETRY_DELAY_MS
            );
            if (isUnmountedRef.current) return;
          } finally {
            inFlightProbesRef.current.delete(controller);
          }
        }

        if (isUnmountedRef.current) return;
        // The tester moved to another scenario while this ran. The answer is
        // about a session the page no longer shows, and its map was cleared.
        if (probedSessionKeyRef.current !== probeSessionKey) return;
        setReachabilityByServerId((previous) => ({
          ...previous,
          [server.serverId]: reachability,
        }));
      })();
    }
  }, [enabled, servers, sessionKey]);

  return reachabilityByServerId;
}

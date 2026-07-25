import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "./UrlElicitationConsent";
import {
  useMrtrElicitationStore,
  type MrtrKeyAnswer,
} from "@/stores/mrtr-elicitation-store";

/* ------------------------------------------------------------------ *
 * Single-active-dialog election (multi-mount safety)
 *
 * PR7 mounts this host on the chat `Thread` (so the reused dialog overlays an
 * MCP App whose App-initiated `tools/call` returned `input_required`) in
 * ADDITION to PR2's per-tab mounts. Several hosts can therefore be mounted at
 * once on the same screen (e.g. local Chat renders `Thread` AND `ChatTabV2`
 * mounts its own host; a multi-model surface renders several `Thread`s). The
 * store and its SSE connection are already singletons, but the *view* was not:
 * every mounted host independently rendered `rounds[0]`, so N co-visible hosts
 * would stack N identical dialogs for the same round.
 *
 * This module-level election makes the view a singleton too: exactly one
 * mounted host (the lowest-numbered still-mounted instance) renders the dialog;
 * the rest render `null`. Registration happens in an effect (never during
 * render — render stays pure), and `useSyncExternalStore` re-derives each
 * host's primary flag when the mounted set changes.
 * ------------------------------------------------------------------ */

const mountedHostIds: number[] = [];
const electionListeners = new Set<() => void>();
let hostIdSeq = 0;

function notifyElection(): void {
  for (const listener of Array.from(electionListeners)) listener();
}

function primaryHostId(): number | null {
  return mountedHostIds.length ? Math.min(...mountedHostIds) : null;
}

/**
 * Returns whether THIS host instance is the elected primary (the one allowed to
 * render the dialog). Safe to call unconditionally at the top of the component
 * so hook order stays stable.
 */
function useIsPrimaryMrtrHost(): boolean {
  const [id] = useState(() => ++hostIdSeq);

  useEffect(() => {
    mountedHostIds.push(id);
    notifyElection();
    return () => {
      const i = mountedHostIds.indexOf(id);
      if (i >= 0) mountedHostIds.splice(i, 1);
      notifyElection();
    };
  }, [id]);

  const subscribe = useCallback((cb: () => void) => {
    electionListeners.add(cb);
    return () => {
      electionListeners.delete(cb);
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => primaryHostId() === id,
    // SSR / first paint before the mount effect registers this id: assume
    // primary so a lone host is never hidden on its initial render.
    () => true,
  );
}

/** Test-only: reset the module-level election between cases. */
export function __resetMrtrHostElection(): void {
  mountedHostIds.length = 0;
  electionListeners.clear();
  hostIdSeq = 0;
}

/**
 * `MrtrElicitationHost` — the shared LOCAL rail that renders the reused
 * elicitation dialog for a modern multi-round-trip (`input_required`) round and
 * feeds the answers back into the SDK driver loop (MCP 2026-07-28 §12.3).
 *
 * Mount it once on each local surface (Tools / Resources / Prompts / Chat). The
 * store is a singleton (one SSE connection, one queue), so multiple mounts
 * cooperate rather than double up.
 *
 * A round may carry several keyed requests. They are collected ONE AT A TIME
 * (spec: show one pending input at a time) into a per-round accumulator, and
 * the whole round is submitted together — every bare response under the exact
 * server key. Responses are per-round: a later round starts with a fresh
 * accumulator (replacement, never accumulation across rounds).
 *
 * Decline / cancel are RESPONSES (an `ElicitResult`), not thrown errors: they
 * are collected like any other answer and sent back for the driver to retry.
 */
export function MrtrElicitationHost() {
  const isPrimary = useIsPrimaryMrtrHost();
  const connect = useMrtrElicitationStore((s) => s.connect);
  const rounds = useMrtrElicitationStore((s) => s.rounds);
  const responding = useMrtrElicitationStore((s) => s.responding);
  const respond = useMrtrElicitationStore((s) => s.respond);

  useEffect(() => {
    connect();
  }, [connect]);

  const activeRound = rounds[0] ?? null;

  // Per-round collection state, reset whenever a different round becomes active.
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, MrtrKeyAnswer>>({});

  useEffect(() => {
    setIndex(0);
    setAnswers({});
  }, [activeRound?.roundKey]);

  const requests = activeRound?.requests ?? [];
  const current = requests[index];

  const serverId = activeRound?.serverId;
  const total = requests.length;

  const submitWhenComplete = useMemo(
    () =>
      async (collected: Record<string, MrtrKeyAnswer>) => {
        if (!activeRound) return;
        await respond(activeRound.opId, collected);
      },
    [activeRound, respond],
  );

  // Only the elected primary host renders the dialog; other mounted hosts on
  // the same screen (e.g. an MCP App `Thread` + a tab's own host) stay silent
  // so a single round never stacks duplicate dialogs. `connect()` above still
  // runs on every instance (idempotent; one shared SSE), so any instance can
  // become primary later without a gap.
  if (!isPrimary || !activeRound || !current) return null;

  const recordAnswer = async (key: string, answer: MrtrKeyAnswer) => {
    // Object.assign onto a fresh object: keys are server-chosen and untrusted.
    const next = Object.assign(
      Object.create(null) as Record<string, MrtrKeyAnswer>,
      answers,
      { [key]: answer },
    );
    if (index + 1 < total) {
      setAnswers(next);
      setIndex(index + 1);
      return;
    }
    // Last key answered — submit the whole round together.
    await submitWhenComplete(next);
  };

  const counter = total > 1 ? ` (${index + 1} of ${total})` : "";

  if (current.mode === "url") {
    return (
      <UrlElicitationConsent
        // Remount per key so popup-blocked / copied state can't bleed across.
        key={`${activeRound.roundKey}:${current.key}`}
        request={{
          // Modern MRTR URL elicitation carries NO elicitationId and there is
          // no completion notification: the user consents (or declines /
          // cancels) and the driver simply retries the original operation.
          rendezvousId: `${activeRound.opId}:${current.key}`,
          serverId: serverId ?? "",
          message: (current.message || "Open a link to continue.") + counter,
          url: current.url,
        }}
        loading={responding}
        onResponse={(action) =>
          recordAnswer(current.key, { action })
        }
      />
    );
  }

  return (
    <ElicitationDialog
      key={`${activeRound.roundKey}:${current.key}`}
      elicitationRequest={{
        requestId: `${activeRound.opId}:${current.key}`,
        message: (current.message || "This operation needs input.") + counter,
        schema: current.requestedSchema,
        timestamp: activeRound.timestamp,
        origin: "mrtr",
        ...(serverId ? { serverId } : {}),
      }}
      loading={responding}
      onResponse={async (action, parameters) =>
        recordAnswer(current.key, {
          action,
          ...(action === "accept" && parameters ? { content: parameters } : {}),
        })
      }
    />
  );
}

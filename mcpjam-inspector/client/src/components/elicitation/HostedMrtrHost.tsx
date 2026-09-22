import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "./UrlElicitationConsent";
import {
  useHostedMrtrStore,
  type HostedMrtrRound,
} from "@/stores/hosted-mrtr-store";
import type { MrtrElicitationResponse } from "@/shared/mrtr-continuation";

/** Stable empty answers reference so `answers` identity is steady across renders. */
const EMPTY_ANSWERS: Record<string, MrtrElicitationResponse> = Object.freeze(
  Object.create(null)
);

/* ------------------------------------------------------------------ *
 * Single-active-dialog election (multi-mount safety)
 *
 * Same hazard, same fix as `MrtrElicitationHost`: the store is a singleton but
 * the VIEW is not, so N co-visible hosts would each render `rounds[0]` and
 * stack N identical dialogs over one suspended operation. Exactly one mounted
 * host (the lowest-numbered still-mounted instance) renders; the rest render
 * `null`. The elections are deliberately SEPARATE from the local host's: a
 * local round and a hosted round are different operations and may legitimately
 * be pending at the same time.
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

/** Whether THIS instance is the elected primary. Hook order stays stable. */
function useIsPrimaryHostedMrtrHost(): boolean {
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
    // First paint, before the mount effect registers this id: assume primary so
    // a lone host is never hidden on its initial render.
    () => true
  );
}

/** Test-only: reset the module-level election between cases. */
export function __resetHostedMrtrHostElection(): void {
  mountedHostIds.length = 0;
  electionListeners.clear();
  hostIdSeq = 0;
}

function counterSuffix(index: number, total: number): string {
  return total > 1 ? ` (${index + 1} of ${total})` : "";
}

/**
 * The wire type of `requestedSchema` is `unknown` (it crosses an untrusted
 * boundary); the dialog takes a plain object. A non-object schema is dropped
 * rather than coerced — the dialog then renders the free-form fallback instead
 * of deriving fields from something that is not a schema.
 */
function asSchemaObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `HostedMrtrHost` — the HOSTED counterpart of `MrtrElicitationHost`: the rail
 * that renders the reused elicitation dialog for a suspended hosted MRTR round
 * (MCP 2026-07-28 §12.5) and hands the collected `ElicitResult`s back to
 * whichever transport enqueued the round (chat turn resume, or the direct-op
 * `/api/web/mrtr/resume` driver).
 *
 * The local host talks to the SSE-backed local store; this one talks to
 * `hosted-mrtr-store`, whose rounds are durable continuations rather than a
 * driver loop held open in this process. Both render the SAME dialogs, so a
 * user cannot tell (nor should they) which transport a round arrived on.
 *
 * A round may carry several keyed requests. They are collected ONE AT A TIME
 * (spec: show one pending input at a time) into a per-round accumulator held in
 * the singleton store, and the whole round is submitted together. Decline /
 * cancel are RESPONSES (an `ElicitResult`), not withdrawals: they are collected
 * like any other answer and sent back so the server can drive the next leg.
 */
export function HostedMrtrHost() {
  const isPrimary = useIsPrimaryHostedMrtrHost();
  const rounds = useHostedMrtrStore((s) => s.rounds);
  const responding = useHostedMrtrStore((s) => s.responding);
  const collection = useHostedMrtrStore((s) => s.collection);
  const setCollection = useHostedMrtrStore((s) => s.setCollection);
  const submit = useHostedMrtrStore((s) => s.submit);

  const activeRound: HostedMrtrRound | null = rounds[0] ?? null;

  // A collection scoped to a different round is stale — a freshly active round
  // always starts at index 0 with no answers.
  const active =
    collection && collection.key === activeRound?.key ? collection : null;
  const index = active?.index ?? 0;
  const answers = active?.answers ?? EMPTY_ANSWERS;

  const requests = activeRound?.requests ?? [];
  const current = requests[index];
  const total = requests.length;

  if (!isPrimary || !activeRound || !current) return null;

  const recordAnswer = async (
    key: string,
    answer: MrtrElicitationResponse
  ): Promise<void> => {
    // Object.assign onto a fresh object: keys are server-chosen and untrusted.
    const next = Object.assign(
      Object.create(null) as Record<string, MrtrElicitationResponse>,
      answers,
      { [key]: answer }
    );
    if (index + 1 < total) {
      setCollection(activeRound.key, index + 1, next);
      return;
    }
    // Last key answered — submit the whole round together. A rejected submit
    // KEEPS the round mounted so the user can retry; swallow here so the
    // dialog's handler never rejects into an unhandled promise.
    try {
      await submit(activeRound.key, next);
    } catch (err) {
      console.error(
        "[hosted-mrtr] Failed to submit round; dialog retained",
        err
      );
    }
  };

  const counter = counterSuffix(index, total);
  const operation = activeRound.operationLabel
    ? ` for “${activeRound.operationLabel}”`
    : "";

  if (current.mode === "url") {
    return (
      <UrlElicitationConsent
        // Remount per key so popup-blocked / copied state can't bleed across.
        key={`${activeRound.key}:${current.key}`}
        request={{
          // Hosted MRTR URL elicitation carries no server-chosen elicitation id
          // and no completion notification: the user consents (or declines /
          // cancels) and the server retries the suspended operation.
          rendezvousId: `${activeRound.continuationId}:${current.key}`,
          serverId: activeRound.serverId,
          ...(activeRound.serverName
            ? { serverName: activeRound.serverName }
            : {}),
          message:
            (current.message || `Open a link to continue${operation}.`) +
            counter,
          url: current.url,
        }}
        loading={responding}
        onResponse={(action) => recordAnswer(current.key, { action })}
      />
    );
  }

  return (
    <ElicitationDialog
      key={`${activeRound.key}:${current.key}`}
      elicitationRequest={{
        requestId: `${activeRound.continuationId}:${current.key}`,
        message:
          (current.message || `This operation needs input${operation}.`) +
          counter,
        schema: asSchemaObject(current.requestedSchema),
        timestamp: activeRound.timestamp,
        origin: "mrtr",
        serverId: activeRound.serverId,
        ...(activeRound.serverName
          ? { serverName: activeRound.serverName }
          : {}),
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

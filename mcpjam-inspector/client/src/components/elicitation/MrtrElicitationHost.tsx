import { useEffect, useMemo, useState } from "react";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "./UrlElicitationConsent";
import {
  useMrtrElicitationStore,
  type MrtrKeyAnswer,
} from "@/stores/mrtr-elicitation-store";

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

  if (!activeRound || !current) return null;

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
    // Last key answered — submit the whole round together. A rejected submit
    // (server still awaiting this round) KEEPS the round mounted so the user can
    // retry from the last key; swallow here to avoid an unhandled rejection.
    try {
      await submitWhenComplete(next);
    } catch (err) {
      console.error("[mrtr] Failed to submit round; dialog retained", err);
    }
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

/**
 * Submitting an answer to a hosted elicitation.
 *
 * This goes DIRECTLY to Convex rather than through an inspector `/api/web`
 * route, because the blocked replica isn't reachable by name: hosted runs
 * behind a load balancer, so the answer would land on an arbitrary replica and
 * still have to cross to the one holding the tool call. Writing straight to the
 * rendezvous table removes that hop entirely — the browser already holds a live
 * authenticated Convex client (signed-in users, guests, and chatbox visitors
 * alike, via `unified-convex-auth`).
 *
 * Authorization is NOT taken from this payload: the mutation re-derives the
 * caller's identity server-side, checks it owns the row, and enforces a
 * one-shot pending→answered transition.
 *
 * Kept behind one function so the transport stays swappable — nothing above it
 * knows which channel carries the answer.
 */

import type { ConvexReactClient } from "convex/react";
import type { HostedElicitationAnswer } from "@/shared/hosted-elicitation";

/**
 * Convex functions are referenced by string name across this client (there is
 * no generated `api` object mirrored into this repo — see the two-repo layout),
 * so a new backend function is callable without any codegen sync.
 */
const RESPOND_FN = "elicitations:respondToElicitation";

export type RespondToElicitationResult =
  | { ok: true }
  | { ok: false; reason: string };

export async function respondToChatElicitation(
  convex: ConvexReactClient,
  answer: HostedElicitationAnswer,
): Promise<RespondToElicitationResult> {
  const result = (await convex.mutation(RESPOND_FN as any, {
    rendezvousId: answer.rendezvousId,
    action: answer.action,
    // Only form-mode accepts carry content; the backend rejects it otherwise.
    ...(answer.content ? { content: answer.content } : {}),
  })) as RespondToElicitationResult | undefined;

  // A backend that predates this feature (or any non-object return) shouldn't
  // read as success — the caller decides what to show.
  return result ?? { ok: false, reason: "unknown" };
}

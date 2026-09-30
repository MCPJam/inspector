/**
 * Phase-0 ChatGPT observation: turning what the probe SAW into dated profile
 * facts (contract C1), without ever recording a secret.
 *
 * The probe (`sdk/scripts/chatgpt-events-probe.ts`) is an instrumented events
 * server deployed at a public HTTPS URL and connected to ChatGPT. It records
 * one {@link ProbeObservation} per thing ChatGPT did or answered. This module
 * is the pure half: it summarizes observations into `observed` profile facts,
 * each carrying the date it was seen. Anything not observed stays
 * `unobserved` — never guessed, never copied from the draft.
 */

import type { ProfileFact } from "./profiles.js";

export type ProbeObservation =
  | {
      kind: "subscribe";
      at: string;
      protocolVersion?: string;
      /** `"omitted"` when the field was absent; `null` when sent as null. */
      ttlMs: number | null | "omitted";
      /** Decoded byte length of `delivery.secret` — the value is never kept. */
      secretBytes: number | null;
      cursorSent: "null" | "omitted" | "value";
      callbackUrlShape: string;
      isRefresh: boolean;
      /** ms between this refresh and the refreshBefore granted before it. */
      leadMs?: number;
    }
  | { kind: "unsubscribe"; at: string; callbackUrlShape: string }
  | { kind: "list"; at: string; protocolVersion?: string }
  | {
      kind: "delivery";
      at: string;
      variant:
        | "valid"
        | "bad-signature"
        | "stale-timestamp"
        | "duplicate"
        | "oversize"
        | "verification";
      status: number | "network_error";
      /** For `verification`: whether the echoed challenge matched. */
      echoMatched?: boolean;
    };

/**
 * Replace every id-looking path segment with `{id}` so the SHAPE of a
 * callback URL is recorded without anything that could route to it.
 */
export function callbackUrlShape(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .map((segment) =>
        segment.length >= 8 && /[0-9]/.test(segment) ? "{id}" : segment
      )
      .join("/");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search ? "?{query}" : ""}`;
  } catch {
    return "(unparseable)";
  }
}

function observed<T>(value: T, date: string): ProfileFact<T> {
  return {
    value,
    provenance: {
      kind: "observed",
      date,
      probe: "sdk/scripts/chatgpt-events-probe.ts",
    },
  };
}

export interface ObservedChatgptFacts {
  requestedTtlMs?: ProfileFact<number | null | "omitted">;
  secretBytes?: ProfileFact<number>;
  refreshLead?: ProfileFact<string>;
  unsubscribesOnEnd?: ProfileFact<boolean>;
  protocolVersions?: ProfileFact<string[]>;
  verificationEcho?: ProfileFact<boolean>;
  deliveryResponses?: ProfileFact<Record<string, number | "network_error">>;
}

/** Summarize probe observations into dated `observed` profile facts. */
export function summarizeProbeObservations(
  observations: ProbeObservation[]
): ObservedChatgptFacts {
  const facts: ObservedChatgptFacts = {};
  const date = (at: string) => at.slice(0, 10);
  const subscribes = observations.filter(
    (o): o is Extract<ProbeObservation, { kind: "subscribe" }> => o.kind === "subscribe"
  );
  const first = subscribes.find((o) => !o.isRefresh);
  if (first) {
    facts.requestedTtlMs = observed(first.ttlMs, date(first.at));
    if (first.secretBytes !== null) {
      facts.secretBytes = observed(first.secretBytes, date(first.at));
    }
  }
  const refreshes = subscribes.filter((o) => o.isRefresh && o.leadMs !== undefined);
  if (refreshes.length > 0) {
    const leads = refreshes.map((o) => o.leadMs!).sort((a, b) => a - b);
    const median = leads[Math.floor(leads.length / 2)]!;
    facts.refreshLead = observed(
      `median ${Math.round(median / 1000)} s before refreshBefore (n=${leads.length}, range ${Math.round(leads[0]! / 1000)}–${Math.round(leads[leads.length - 1]! / 1000)} s)`,
      date(refreshes[refreshes.length - 1]!.at)
    );
  }
  const unsubscribe = observations.find((o) => o.kind === "unsubscribe");
  if (unsubscribe) facts.unsubscribesOnEnd = observed(true, date(unsubscribe.at));
  const versions = [
    ...new Set(
      observations
        .map((o) => ("protocolVersion" in o ? o.protocolVersion : undefined))
        .filter((v): v is string => typeof v === "string")
    ),
  ];
  const withVersion = observations.find((o) => "protocolVersion" in o && o.protocolVersion);
  if (versions.length > 0 && withVersion) {
    facts.protocolVersions = observed(versions, date(withVersion.at));
  }
  const deliveries = observations.filter(
    (o): o is Extract<ProbeObservation, { kind: "delivery" }> => o.kind === "delivery"
  );
  const verification = deliveries.find((o) => o.variant === "verification");
  if (verification) {
    facts.verificationEcho = observed(verification.echoMatched === true, date(verification.at));
  }
  const responses = deliveries.filter((o) => o.variant !== "verification");
  if (responses.length > 0) {
    const byVariant: Record<string, number | "network_error"> = {};
    for (const response of responses) byVariant[response.variant] = response.status;
    facts.deliveryResponses = observed(byVariant, date(responses[responses.length - 1]!.at));
  }
  return facts;
}

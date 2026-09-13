/**
 * Turn one run's server-facts document into the lines a reader sees.
 *
 * ── WHY A SIBLING TYPE AND NOT `suite-stage-facts.ts` ────────────────────────
 *
 * That module's `StageFactLine` looks identical and is NOT the same thing: it
 * describes a suite's stored CONFIGURATION, and its vocabulary is pinned by
 * `stageFactStrings` precisely so run-state words ("passed", "not measured")
 * can never appear in it. These lines describe an OBSERVED run. Sharing the
 * type would put run words one import away from a pin that exists to keep them
 * out, so the shape is copied and the pin is left alone.
 *
 * ── EVERY LINE IS A FACT ─────────────────────────────────────────────────────
 *
 * A tool count is not a defect. A connect duration is not a failure. A
 * precheck is a signal, and only the `spec_required` class is a violation of
 * anything. Nothing here has a pass/fail tone, and the only `attention` tone
 * is reserved for a failed setup phase and for spec violations — the two
 * things that ARE claims about correctness.
 *
 * ── TOKENS SAY "ESTIMATE", EVERY TIME ────────────────────────────────────────
 *
 * There is no tokenizer in this stack. Every token number is rendered with a
 * `~`, and its note carries the document's own disclaimer, so a reader cannot
 * pick up the number without the caveat attached to it.
 */

import {
  SERVER_FACTS_REFERENCE_WINDOW_TOKENS,
  referenceWindowShare,
  type EvalRunServerFactsV1,
  type ServerFactsPrecheck,
  type ServerFactsServer,
} from "@mcpjam/sdk/contract";
import type { ServerFactsFailureKind } from "@/lib/apis/eval-server-facts-api";

/** One rendered fact. Deliberately NOT `StageFactLine` — see the header. */
export type RunFactLine = {
  /** Stable within a render; a React key, not persisted. */
  id: string;
  label: string;
  value: string;
  tone: "set" | "empty" | "attention";
  /** The caveat a value cannot be read without. */
  note?: string;
};

/** `19,800` → `~19.8k`. Compact, and always prefixed to read as approximate. */
export function formatApproxTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "~0";
  if (tokens < 1000) return `~${tokens}`;
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** `0.099` → `10%`. Whole percents: the input is an estimate already. */
export function formatWindowShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return `${Math.round(share * 100)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What a payload number was measured on, said in words. */
export function payloadBasisNote(server: ServerFactsServer): string {
  const basis =
    server.payload.basis === "aggregated_catalog_json"
      ? "the tool catalog as the client assembled it, measured at capture"
      : "the tool catalog as we retained it, which is smaller than what the server sent";
  return server.payload.complete
    ? basis
    : `${basis} — incomplete, some fields were not kept`;
}

/**
 * The one-line summary: servers, tools, and an estimated share of a reference
 * window.
 *
 * "of a 200k window" is in the string on purpose. The share means nothing
 * without its denominator, and a bare percentage reads as a measurement of the
 * model's actual context — which nothing here knows.
 */
export function summarizeServerFacts(
  document: EvalRunServerFactsV1,
): string {
  if (document.servers.length === 0) {
    return document.reason === "snapshotMissing"
      ? "No tool snapshot was captured for this run"
      : "No servers were captured for this run";
  }
  const tools = document.servers.reduce(
    (total, server) => total + server.toolCount,
    0,
  );
  const tokens = document.servers.reduce(
    (total, server) => total + server.estimatedTokens,
    0,
  );
  // Through the contract helper, which is the only way a rate is minted in
  // this document — it is what refuses a non-finite or negative input rather
  // than rendering `NaN%` at a reader.
  const share = referenceWindowShare(tokens);
  const serverWord = document.servers.length === 1 ? "server" : "servers";
  return (
    `${document.servers.length} ${serverWord} · ${tools} tools · ` +
    `${formatApproxTokens(tokens)} tokens (${formatWindowShare(share)} of a ` +
    `${formatApproxTokens(SERVER_FACTS_REFERENCE_WINDOW_TOKENS)} window)`
  );
}

/**
 * Why the READ produced no document — as distinct from a document that says
 * it has nothing to describe.
 *
 * Silence is the one answer a reader cannot act on, and it is the answer they
 * got: the card rendered only on `ready`, so a deployment that does not serve
 * the route yet, a read that failed, and a run nobody can see were all the
 * same blank space under the stage strip. The shape follows
 * `FINDINGS_FAILURE_COPY` in `use-stage-findings.tsx`, which answers the same
 * question for the sibling document.
 *
 * None of these is a finding about the server under test, and none may read
 * as one — the stage strip above is a different document and stays rendered.
 */
export const SERVER_FACTS_FAILURE_COPY: Record<
  ServerFactsFailureKind,
  { title: string; detail: string }
> = {
  notFound: {
    title: "No server facts for this run",
    detail:
      "This project has no run with that id, or it is no longer visible here.",
  },
  routeUnavailable: {
    title: "Server facts are not available on this deployment",
    detail:
      "The API this app is talking to does not serve the server-facts contract yet, so the snapshot this run ran against is not described here.",
  },
  invalidContract: {
    title: "The server facts did not match their contract",
    detail:
      "The API answered with a payload this build cannot validate, so nothing from it is shown. The stages above come from a different document and are unaffected.",
  },
  requestFailed: {
    title: "Couldn't load the server facts",
    detail:
      "The read did not complete, so the snapshot this run ran against is not described here. It will be retried automatically.",
  },
};

/** Why a document has no servers, in a sentence a reader can act on. */
export function unavailableReasonCopy(
  document: EvalRunServerFactsV1,
): string | null {
  switch (document.reason) {
    case "snapshotMissing":
      return "This run stored no tool snapshot, so there is nothing to describe. Runs started before snapshot capture shipped have none, and a purged snapshot leaves none.";
    case "snapshotPartial":
      return "One or more servers could not be listed. The servers that answered are shown; the rest are not zero, they are unmeasured.";
    case "setupNotObserved":
      return "The run recorded no setup audit, so connect and discovery are unmeasured — not failed.";
    default:
      return null;
  }
}

/** The Connection lines: outcome, attribution, and the phase's wall time. */
export function connectionLines(
  document: EvalRunServerFactsV1,
): RunFactLine[] {
  const phase = document.setup.connection;
  if (!phase) {
    return [
      {
        id: "connection:absent",
        label: "Connection",
        // NOT "failed". An unobserved phase and a failed one are different
        // facts, and reporting the first as the second invents a defect.
        value: "not observed",
        tone: "empty",
      },
    ];
  }
  const lines: RunFactLine[] = [
    {
      id: "connection:outcome",
      label: "Connection",
      value: phase.outcome === "ok" ? "connected" : "failed",
      tone: phase.outcome === "ok" ? "set" : "attention",
    },
  ];
  if (phase.outcome === "failed") {
    lines.push({
      id: "connection:attribution",
      label: "Attributed to",
      value:
        phase.attribution === "theirs"
          ? "the server"
          : phase.attribution === "ours"
            ? "us"
            : "unknown",
      tone: "empty",
      // A failure with no positive egress evidence is never blamed on the
      // server, and the line says which of the two we could establish.
      note: phase.egressVerified
        ? "our own egress was verified working"
        : "our egress was not verified, so this is not attributed to the server",
    });
  }
  if (phase.durationMs !== undefined) {
    lines.push({
      id: "connection:duration",
      label: "Connect time",
      value: `${phase.durationMs} ms`,
      tone: "set",
      // The number is per RUN, not per trial. A run with 200 trials copies one
      // connect onto all of them, and a reader who averages it gets a
      // three-second connection measured 200 times.
      note: "measured once for the run, not per iteration",
    });
  }
  return lines;
}

/** The Discovery lines: the tool surface, its size, and its shape. */
export function discoveryLines(
  document: EvalRunServerFactsV1,
): RunFactLine[] {
  const lines: RunFactLine[] = [];
  const phase = document.setup.discovery;
  if (phase) {
    lines.push({
      id: "discovery:outcome",
      label: "Discovery",
      value: phase.outcome === "ok" ? "tools listed" : "failed",
      tone: phase.outcome === "ok" ? "set" : "attention",
      ...(phase.durationMs !== undefined
        ? { note: `${phase.durationMs} ms, measured once for the run` }
        : {}),
    });
  }
  for (const server of document.servers) {
    if (server.capture === "failed") {
      lines.push({
        id: `discovery:${server.serverId}:capture`,
        label: server.serverId,
        value: "not captured",
        tone: "empty",
        note: "this server did not answer; its numbers are absent, not zero",
      });
      continue;
    }
    lines.push({
      id: `discovery:${server.serverId}:tools`,
      label: server.serverId,
      value: `${server.toolCount} tools`,
      tone: "set",
    });
    lines.push({
      id: `discovery:${server.serverId}:payload`,
      label: "Catalog size",
      value: `${formatBytes(server.payload.bytes)} · ${formatApproxTokens(
        server.estimatedTokens,
      )} tokens`,
      tone: "set",
      note: `${payloadBasisNote(server)}. ${document.tokenEstimate.note}.`,
    });
    lines.push({
      id: `discovery:${server.serverId}:share`,
      label: "Share of a reference window",
      value: formatWindowShare(server.referenceWindowShare),
      tone: "set",
      note: `of ${formatApproxTokens(
        document.tokenEstimate.referenceWindowTokens,
      )} tokens. ${document.tokenEstimate.note}.`,
    });
    lines.push({
      id: `discovery:${server.serverId}:annotations`,
      label: "Annotations",
      value: `${server.annotations.withReadOnlyHint}/${server.annotations.total} readOnly · ${server.annotations.withDestructiveHint} destructive`,
      tone: server.annotations.withReadOnlyHint > 0 ? "set" : "empty",
      note: "a hint the server declares; absent is not the same as false",
    });
    lines.push({
      id: `discovery:${server.serverId}:outputSchema`,
      label: "Output schemas",
      value: `${server.outputSchema.present}/${server.outputSchema.total}`,
      tone: server.outputSchema.present > 0 ? "set" : "empty",
      note: "optional under the spec; present schemas let a check grade the shape of a result",
    });
  }
  return lines;
}

export type PrecheckGroup = {
  toolName: string;
  rows: ServerFactsPrecheck[];
};

/**
 * Prechecks grouped by tool, most findings first.
 *
 * By TOOL, because that is the unit a server developer edits. A flat list
 * sorted by code makes someone fixing one tool read the whole page.
 */
export function groupPrechecksByTool(
  server: ServerFactsServer,
): PrecheckGroup[] {
  const byTool = new Map<string, ServerFactsPrecheck[]>();
  for (const row of server.prechecks) {
    const rows = byTool.get(row.toolName) ?? [];
    rows.push(row);
    byTool.set(row.toolName, rows);
  }
  return [...byTool.entries()]
    .map(([toolName, rows]) => ({ toolName, rows }))
    .sort(
      (left, right) =>
        right.rows.length - left.rows.length ||
        left.toolName.localeCompare(right.toolName),
    );
}

/**
 * How a precheck should read.
 *
 * `spec_required` is the only class that names a violation, and a row marked
 * `protocolDependent` is not even that — it is a rule we could not tell
 * applied, and saying so is the difference between reporting a defect and
 * reporting a question.
 */
export function precheckTone(
  row: ServerFactsPrecheck,
): "attention" | "set" | "empty" {
  if (row.protocolDependent) return "empty";
  return row.class === "spec_required" ? "attention" : "set";
}

export function precheckQualifier(row: ServerFactsPrecheck): string | null {
  if (row.protocolDependent) return "depends on protocol version";
  if (row.class === "spec_required") return "required by the spec";
  if (row.class === "spec_recommended") return "recommended by the spec";
  return null;
}

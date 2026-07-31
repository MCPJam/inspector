/**
 * HP-44 — human-readable rendering of a trace diff and a capture report.
 *
 * Written for a reviewer deciding whether to trust a parity claim, so the
 * ordering is deliberate: differences first (actionable), then gaps (what we
 * could not see), then a match count (not a match list — nobody reads forty
 * lines of "matches"). Gaps are given as much prominence as differences because
 * "the emulator matched everything we looked at, and we looked at very little"
 * is the failure mode this harness exists to make visible.
 */

import type { HarIngestReport } from "./from-har.js";
import type {
  GoldenTrace,
  TraceDiffFinding,
  TraceDiffLabels,
  TraceDiffResult,
} from "./types.js";

const VALUE_LIMIT = 160;

function renderValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT - 1)}…` : value;
  }
  const json = JSON.stringify(value);
  if (json == null) return String(value);
  return json.length > VALUE_LIMIT ? `${json.slice(0, VALUE_LIMIT - 1)}…` : json;
}

/**
 * Side labels come from the RESULT, never from this module.
 *
 * `result.labels` is what the differ phrased its own messages with, so deriving
 * the value lines from anything else lets the heading contradict the prose right
 * underneath it. Hardcoded "real host" / "emulator" did exactly that for a
 * `drift` diff (HP-38: the same subject captured twice, no emulator on either
 * side) — blaming an emulator that was never involved.
 */
function renderFinding(finding: TraceDiffFinding, labels: TraceDiffLabels): string[] {
  const lines = [`  • [${finding.dimension}] ${finding.message}`, `    at ${finding.path}`];
  if (finding.golden !== undefined || finding.candidate !== undefined) {
    const width = Math.max(labels.golden.length, labels.candidate.length);
    lines.push(`    ${`${labels.golden}:`.padEnd(width + 1)} ${renderValue(finding.golden)}`);
    lines.push(
      `    ${`${labels.candidate}:`.padEnd(width + 1)} ${renderValue(finding.candidate)}`,
    );
  }
  return lines;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Render a diff result as plain text. */
export function formatTraceDiffHuman(result: TraceDiffResult): string {
  const lines: string[] = [];
  const labels = result.labels;

  lines.push(`OAuth golden-trace ${result.mode} diff`);
  lines.push(`  golden (${labels.golden}): ${result.goldenTraceId}`);
  lines.push(`  candidate (${labels.candidate}): ${result.candidateTraceId}`);
  lines.push("");

  const incomparable = result.findings.filter((f) => f.severity === "incomparable");
  if (incomparable.length > 0) {
    lines.push("INCOMPARABLE — no field-level comparison was attempted:");
    for (const finding of incomparable) lines.push(...renderFinding(finding, labels));
    lines.push("");
    lines.push(result.summary);
    return lines.join("\n");
  }

  const differences = result.findings.filter((f) => f.severity === "difference");
  if (differences.length > 0) {
    lines.push(
      `DIFFERENCES (${differences.length}) — the ${labels.candidate} does not match the ${labels.golden}:`,
    );
    for (const finding of differences) lines.push(...renderFinding(finding, labels));
    lines.push("");
  }

  const gaps = result.findings.filter((f) => f.severity === "gap");
  if (gaps.length > 0) {
    lines.push(
      `GAPS (${gaps.length}) — not comparable, because one side never observed it. These are NOT passes:`,
    );
    for (const finding of gaps) lines.push(...renderFinding(finding, labels));
    lines.push("");
  }

  lines.push(`MATCHES: ${result.counts.match}`);
  lines.push("");
  lines.push(
    result.parity
      ? `PARITY on every comparable field (${pluralize(result.counts.gap, "gap")} remaining).`
      : `NO PARITY: ${pluralize(result.counts.difference, "difference")}, ${pluralize(result.counts.gap, "gap")}.`,
  );
  if (result.parity && result.counts.gap > 0) {
    lines.push(
      "  Read the gaps before treating this as a green result — parity over a small observed surface is a weak claim.",
    );
  }

  return lines.join("\n");
}

/**
 * Origin and path only — never the query string or fragment.
 *
 * A DROPPED HAR entry never went through `./normalize.js`: it is reported straight
 * off the input, so its query may still carry a live `code`, `client_secret` or
 * `access_token`. The trace itself is redacted at capture time, and rendering a
 * raw URL here would leak past that guarantee into a human report and from there
 * into CI logs. Diagnosing a filter mistake needs the ENDPOINT, never the
 * parameters, so they are dropped rather than truncated — a truncated query string
 * still leaks its beginning.
 */
function sanitizeUrlForReport(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not a parseable URL (or a placeholder like `<no url>`): keep only what
    // precedes the first `?` or `#`, which cannot hold a query parameter.
    return raw.split(/[?#]/)[0];
  }
}

/** Render a HAR ingest report — the "what we could not capture" deliverable. */
export function formatHarIngestReportHuman(report: HarIngestReport): string {
  const lines: string[] = [];
  lines.push(
    `HAR ingest: kept ${report.keptEntries} of ${report.totalEntries} entries.`,
  );

  if (report.missingLegs.length > 0) {
    lines.push("");
    lines.push(
      `MISSING LEGS (${report.missingLegs.length}) — every field these would have carried is recorded as \`not-observed\`:`,
    );
    for (const leg of report.missingLegs) lines.push(`  • ${leg}`);
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(`WARNINGS (${report.warnings.length}):`);
    for (const warning of report.warnings) lines.push(`  • ${warning}`);
  }

  if (report.dropped.length > 0) {
    lines.push("");
    lines.push(`DROPPED (${report.dropped.length}) — treated as unrelated traffic:`);
    // Group by reason so a systematic filter mistake is obvious rather than
    // buried in a hundred near-identical lines.
    const byReason = new Map<string, string[]>();
    for (const entry of report.dropped) {
      const bucket = byReason.get(entry.reason) ?? [];
      bucket.push(sanitizeUrlForReport(entry.url));
      byReason.set(entry.reason, bucket);
    }
    for (const [reason, urls] of byReason) {
      lines.push(`  • ${reason} (${urls.length})`);
      for (const url of urls.slice(0, 5)) lines.push(`      ${renderValue(url)}`);
      if (urls.length > 5) lines.push(`      … and ${urls.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * One-line trace summary, for listing committed traces.
 *
 * `absent` and `not-observed` are rendered DIFFERENTLY. Collapsing them to
 * "unknown" erases the distinction the whole schema exists to preserve: "this host
 * exposes no version" is a positive finding about the host, while "we never read a
 * version" is a durability gap in the capture. A reviewer scanning this listing is
 * exactly the person who needs to tell them apart.
 */
export function formatTraceSummaryHuman(trace: GoldenTrace): string {
  const version =
    trace.subject.hostVersion.state === "present"
      ? trace.subject.hostVersion.value
      : trace.subject.hostVersion.state === "absent"
        ? "no version exposed"
        : "version not observed";
  const implementation =
    trace.subject.oauthImplementation.state === "present"
      ? trace.subject.oauthImplementation.value.kind === "dependency"
        ? `${trace.subject.oauthImplementation.value.package}@${trace.subject.oauthImplementation.value.version}`
        : "first-party"
      : trace.subject.oauthImplementation.state === "absent"
        ? "no OAuth implementation declared"
        : "implementation not observed";

  return `${trace.traceId}  [${trace.subject.kind}] ${version} · ${implementation} · ${trace.wire.length} exchanges · captured ${trace.capture.capturedAt}`;
}

/**
 * Per-iteration evidence for the local run's HTML and JUnit reports: each
 * iteration's tool calls (name and arguments), tokens, scorer results and
 * duration, for EVERY case. Passing cases are included on purpose: a pass is
 * a claim, and a reader who cannot see what the model called has to take it
 * on trust.
 *
 * Pure and browser-safe, like `report.ts`. It renders only from the report it
 * is handed, which the structured renderers have already redacted, and never
 * re-reads the run. HTML goes through the caller's escaper; the JUnit text is
 * plain and the caller escapes it for XML. Long values are cut at
 * {@link ITERATION_EVIDENCE_LIMITS} so one large tool call cannot balloon a CI
 * artifact. The JSON report keeps every value in full.
 */

import {
  authRequiredLabel,
  type LocalEvalRunMetadata,
  type LocalEvalRunReport,
  type LocalRunHtmlEscaper,
} from "./report.js";

type LocalCase = LocalEvalRunMetadata["cases"][number];
type LocalIteration = LocalCase["iterations"][number];
type LocalToolCall = LocalIteration["toolCalls"][number];
type LocalScore = LocalIteration["scores"][number];

/** What each renderer shows before it cuts a value. */
export const ITERATION_EVIDENCE_LIMITS = {
  /** Characters of pretty-printed argument JSON per tool call, in HTML. */
  htmlArgumentChars: 2000,
  /** Characters of compact argument JSON per tool call, in JUnit. */
  textArgumentChars: 500,
  /** Characters of a scorer reason or an iteration error, in both. */
  reasonChars: 1000,
  /** Tool calls listed per iteration; the rest are counted, not shown. */
  toolCallsPerIteration: 25,
} as const;

const LIMITS = ITERATION_EVIDENCE_LIMITS;

type Capped = { text: string; omitted: number };

function cap(value: string, max: number): Capped {
  if (value.length <= max) return { text: value, omitted: 0 };
  // Never end on the first half of a surrogate pair: XML refuses a lone half.
  const last = value.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { text: value.slice(0, end), omitted: value.length - end };
}

function truncationNote(capped: Capped): string {
  const total = capped.text.length + capped.omitted;
  return `truncated: showing the first ${capped.text.length} of ${total} characters`;
}

/** Malformed model JSON has no object form, so it is shown as sent. */
function argumentText(call: LocalToolCall, pretty: boolean): string {
  if (call.rawArguments !== undefined) return call.rawArguments;
  return JSON.stringify(call.arguments, null, pretty ? 2 : undefined);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function caseTotals(entry: LocalCase): string {
  let toolCalls = 0;
  let tokens = 0;
  let durationMs = 0;
  for (const iteration of entry.iterations) {
    toolCalls += iteration.toolCalls.length;
    tokens += iteration.tokens.total;
    durationMs += iteration.durationMs;
  }
  return [
    entry.verdict,
    plural(entry.iterations.length, "iteration"),
    plural(toolCalls, "tool call"),
    `${tokens} tokens`,
    `${Math.round(durationMs)}ms`,
  ].join(" · ");
}

function iterationLine(iteration: LocalIteration): string {
  const outcome = [
    iteration.status.replace(/_/gu, " "),
    iteration.taskVerdict,
    iteration.evaluatorError ? "evaluator error" : undefined,
    iteration.refusal ? `refusal: ${iteration.refusal}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const { input, output, total } = iteration.tokens;
  return `${outcome} · ${Math.round(iteration.durationMs)}ms · tokens ${input} input / ${output} output / ${total} total`;
}

function scoreResult(score: LocalScore): string {
  if (score.passed === undefined) return "—";
  return score.passed ? "pass" : "fail";
}

/** Error, sign-in challenge and policy blocks: the context a call list lacks. */
function iterationNotes(iteration: LocalIteration): string[] {
  const notes: string[] = [];
  if (iteration.error) {
    const error = cap(iteration.error, LIMITS.reasonChars);
    notes.push(
      `error: ${error.text}${error.omitted > 0 ? ` … [${truncationNote(error)}]` : ""}`
    );
  }
  if (iteration.authRequired) {
    notes.push(authRequiredLabel(iteration.authRequired));
  }
  if (iteration.policyBlocks.length > 0) {
    notes.push(
      `blocked by tool policy: ${iteration.policyBlocks
        .map((block) => `${block.toolName} (${block.reason})`)
        .join(", ")}`
    );
  }
  return notes;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

/** Styles for {@link renderLocalRunEvidenceHtml}, appended to the page's. */
export const LOCAL_RUN_EVIDENCE_STYLE = `
  details.case-evidence {
    border: 1px solid color-mix(in srgb, GrayText 30%, transparent);
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
    margin: 0.5rem 0;
  }
  details.case-evidence > summary { cursor: pointer; }
  details.case-evidence .iteration {
    border-top: 1px solid color-mix(in srgb, GrayText 30%, transparent);
    margin-top: 0.75rem;
    padding-top: 0.25rem;
  }
  details.case-evidence h4 { margin: 0.5rem 0 0.25rem; }
  details.case-evidence ol { padding-left: 1.25rem; }
`;

function toolCallHtml(
  call: LocalToolCall,
  escapeHtml: LocalRunHtmlEscaper
): string {
  const shown = cap(argumentText(call, true), LIMITS.htmlArgumentChars);
  const raw =
    call.rawArguments !== undefined
      ? ' <span class="note">(not a JSON object; shown as the model sent it)</span>'
      : "";
  const cut =
    shown.omitted > 0
      ? `<p class="note">Arguments ${truncationNote(shown)}.</p>`
      : "";
  return `<li><code>${escapeHtml(call.toolName)}</code>${raw}<pre class="details">${escapeHtml(shown.text)}</pre>${cut}</li>`;
}

function scoreRowHtml(
  score: LocalScore,
  escapeHtml: LocalRunHtmlEscaper
): string {
  const reason = score.reason
    ? cap(score.reason, LIMITS.reasonChars)
    : undefined;
  const reasonCell = reason
    ? `${escapeHtml(reason.text)}${reason.omitted > 0 ? ` <span class="note">(${truncationNote(reason)})</span>` : ""}`
    : "";
  return `<tr><td>${escapeHtml(score.scorerId)}</td><td>${escapeHtml(score.role ?? "—")}</td><td>${escapeHtml(score.status.replace(/_/gu, " "))}</td><td>${scoreResult(score)}</td><td>${reasonCell}</td></tr>`;
}

function iterationHtml(
  iteration: LocalIteration,
  escapeHtml: LocalRunHtmlEscaper
): string {
  const shownCalls = iteration.toolCalls.slice(0, LIMITS.toolCallsPerIteration);
  const hiddenCalls = iteration.toolCalls.length - shownCalls.length;
  const calls =
    iteration.toolCalls.length === 0
      ? '<p class="note">No tool calls.</p>'
      : `<p>Tool calls (${iteration.toolCalls.length})</p>
  <ol class="tool-calls">${shownCalls.map((call) => toolCallHtml(call, escapeHtml)).join("")}</ol>${
    hiddenCalls > 0
      ? `<p class="note">${plural(hiddenCalls, "more tool call")} not shown.</p>`
      : ""
  }`;
  const scores =
    iteration.scores.length === 0
      ? '<p class="note">No scorer results.</p>'
      : `<table class="bucket-table">
  <caption>Scorers</caption>
  <thead><tr><th>Scorer</th><th>Role</th><th>Status</th><th>Result</th><th>Reason</th></tr></thead>
  <tbody>${iteration.scores.map((score) => scoreRowHtml(score, escapeHtml)).join("")}</tbody>
  </table>`;
  const notes = iterationNotes(iteration)
    .map((note) => `<p class="note">${escapeHtml(note)}</p>`)
    .join("");
  return `<div class="iteration">
  <h4>Iteration ${iteration.iterationNumber}</h4>
  <p class="meta">${escapeHtml(iterationLine(iteration))}</p>
  ${notes}
  ${calls}
  ${scores}
  </div>`;
}

function caseHtml(entry: LocalCase, escapeHtml: LocalRunHtmlEscaper): string {
  const iterations =
    entry.iterations.length === 0
      ? '<p class="note">No iterations ran.</p>'
      : entry.iterations
          .map((iteration) => iterationHtml(iteration, escapeHtml))
          .join("\n");
  return `<details class="case-evidence">
  <summary><strong>${escapeHtml(entry.caseId)}</strong> ${escapeHtml(entry.title)} <span class="note">· ${escapeHtml(caseTotals(entry))}</span></summary>
  ${iterations}
</details>`;
}

/**
 * One collapsed `<details>` per case with its iterations' evidence, so the
 * page's top-level view stays the summary table and a reader opens only the
 * case they want to check.
 */
export function renderLocalRunEvidenceHtml(
  report: LocalEvalRunReport,
  escapeHtml: LocalRunHtmlEscaper
): string {
  const cases = report.metadata.cases;
  if (cases.length === 0) return "";
  return `<section class="local-run-evidence">
  <h2>Iteration evidence</h2>
  <p class="note">Tool calls, tokens, scorer results and duration for every iteration. Arguments over ${LIMITS.htmlArgumentChars} characters, reasons over ${LIMITS.reasonChars} characters and calls past ${LIMITS.toolCallsPerIteration} per iteration are cut here; the JSON report has them in full.</p>
  ${cases.map((entry) => caseHtml(entry, escapeHtml)).join("\n  ")}
</section>`;
}

// ── JUnit text ───────────────────────────────────────────────────────────────

function toolCallText(call: LocalToolCall): string {
  const shown = cap(argumentText(call, false), LIMITS.textArgumentChars);
  const raw =
    call.rawArguments !== undefined ? " (not a JSON object; as sent)" : "";
  const cut = shown.omitted > 0 ? ` … [${truncationNote(shown)}]` : "";
  return `  tool call ${call.toolName}${raw} ${shown.text}${cut}`;
}

function scoreText(score: LocalScore): string {
  const role = score.role ? ` (${score.role})` : "";
  const reason = score.reason
    ? cap(score.reason, LIMITS.reasonChars)
    : undefined;
  const because = reason
    ? ` — ${reason.text}${reason.omitted > 0 ? ` … [${truncationNote(reason)}]` : ""}`
    : "";
  return `  scorer ${score.scorerId}${role}: ${score.status.replace(/_/gu, " ")}, ${scoreResult(score)}${because}`;
}

function iterationText(iteration: LocalIteration): string[] {
  const shownCalls = iteration.toolCalls.slice(0, LIMITS.toolCallsPerIteration);
  const hiddenCalls = iteration.toolCalls.length - shownCalls.length;
  return [
    `iteration ${iteration.iterationNumber}: ${iterationLine(iteration)}`,
    ...iterationNotes(iteration).map((note) => `  ${note}`),
    ...(iteration.toolCalls.length === 0
      ? ["  no tool calls"]
      : shownCalls.map(toolCallText)),
    ...(hiddenCalls > 0
      ? [`  ${plural(hiddenCalls, "more tool call")} not shown`]
      : []),
    ...(iteration.scores.length === 0
      ? ["  no scorer results"]
      : iteration.scores.map(scoreText)),
  ];
}

/**
 * Each case's evidence as plain text, keyed by case id: what a JUnit
 * `<testcase>` carries in its own `<system-out>`. The caller escapes it.
 */
export function localRunCaseEvidenceText(
  report: LocalEvalRunReport
): Map<string, string> {
  return new Map(
    report.metadata.cases.map((entry) => [
      entry.caseId,
      [
        `case ${entry.caseId}: ${caseTotals(entry)}`,
        ...(entry.iterations.length === 0
          ? ["no iterations ran"]
          : entry.iterations.flatMap(iterationText)),
      ].join("\n"),
    ])
  );
}

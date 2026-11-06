/**
 * The review pipeline's one comment on a PR. Every run rewrites it in place
 * from a state block it carries, so the PR shows one current account instead
 * of a review per run: the PR's key decisions, what still needs a person, what
 * the bot fixed, and where the pipeline is.
 *
 * Only the bot's own copy is read or edited: a person can paste the markers,
 * but cannot edit the bot's comment.
 */
import {
  HOLD_LABEL, PHASES, SUMMARY_MARKER, decodeState, encodeState, findSummary, paginate, phaseMarker,
} from "./review-common.mjs";

const MAX_BODY = 60_000;
const MAX_OPEN_PER_PHASE = 15;
const MAX_FIXES = 40;
const MAX_SNIPPET = 2_000;
const MAX_TRIAGED = 30;

export const emptyState = () => ({
  status: "", hold: false, triaged: [], fixes: [], open: {}, decisions: [], review: null, notes: [],
  heldReviewers: [], handoff: null,
});

const clip = (value, max = MAX_SNIPPET) => (value.length > max ? `${value.slice(0, max)}\n…` : value);

/** Items worth carrying to the next run, trimmed so the state block stays small. */
const keep = (item) => ({
  category: item.category, title: item.title, path: item.path, find: clip(item.find ?? ""),
  replace: clip(item.replace ?? ""), why: item.why, options: item.options ?? [], downgraded: item.downgraded ?? "",
});

/**
 * Fold one triaged phase into the state. A phase is only triaged once every
 * phase before it passed, so their open items are resolved and drop out; the
 * phase's own items replace its previous ones; later phases keep theirs until
 * they run again.
 */
export function recordPhase(state, { gate, triage, autofixed, commitUrl }) {
  const order = PHASES.map((phase) => phase.id);
  const at = order.indexOf(gate.phase);
  const open = Object.fromEntries(Object.entries(state.open ?? {}).filter(([phase]) => order.indexOf(phase) > at));
  // An autofix that did not apply was already turned into a suggestion.
  open[gate.phase] = triage.items.filter((item) => item.category !== "autofix").slice(0, MAX_OPEN_PER_PHASE).map(keep);
  const fixes = [
    ...autofixed.map((item) => ({ sha: item.sha, url: commitUrl(item.sha), commit: item.commit, why: item.why, phase: gate.phase })),
    ...(state.fixes ?? []),
  ].slice(0, MAX_FIXES);
  const next = {
    ...state, open, fixes,
    triaged: [phaseMarker(gate.phase, gate.sha), ...(state.triaged ?? [])].slice(0, MAX_TRIAGED),
  };
  if (gate.phase === "review") {
    next.decisions = triage.decisions ?? [];
    next.review = { verdict: triage.verdict, summary: triage.summary, sha: gate.sha };
    next.notes = triage.notes ?? [];
  }
  return next;
}

const fence = (body) => "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(([run]) => run.length + 1)));

function openEntry(item, phaseName) {
  const kind = item.category === "suggest" ? "Suggested change" : "Needs a decision";
  const lines = [`#### ${item.path ? `\`${item.path}\`: ` : ""}${item.title}`, `_${kind}, from ${phaseName}._`, "", item.why];
  if (item.downgraded) lines.push("", `_Not fixed by the bot: ${item.downgraded}._`);
  if (item.options.length) lines.push("", ...item.options.map((option, index) => `${index + 1}. ${option}`));
  if (item.category === "suggest" && (item.find || item.replace)) {
    const change = [...item.find.split("\n").map((line) => `-${line}`),
      ...(item.replace ? item.replace.split("\n").map((line) => `+${line}`) : [])].join("\n");
    const marks = fence(change);
    lines.push("", `${marks}diff`, change, marks);
  }
  return lines.join("\n");
}

export function render(state) {
  const parts = [SUMMARY_MARKER, "## Review pipeline", ""];
  if (state.status) parts.push(state.status, "");
  if (state.hold) parts.push(`Kept as a draft because of the \`${HOLD_LABEL}\` label. Remove it to hand the PR to a reviewer.`, "");

  if (state.decisions?.length) {
    parts.push("### Key decisions in this PR", "");
    state.decisions.forEach((entry, index) => {
      parts.push(`${index + 1}. **${entry.decision}**`, `   - Why: ${entry.why}`,
        `   - Alternative: ${entry.alternative}`, `   - Risk if wrong: ${entry.risk}`);
    });
    parts.push("");
  }

  const open = PHASES.flatMap((phase) => (state.open?.[phase.id] ?? []).map((item) => ({ item, phase })));
  if (open.length) {
    parts.push(`### Needs your call (${open.length})`, "", ...open.map(({ item, phase }) => openEntry(item, phase.name)), "");
  }

  if (state.review) {
    parts.push("### Review", "", state.review.summary, "", `Verdict: **${state.review.verdict}** on \`${state.review.sha.slice(0, 7)}\``, "");
  }

  if (state.fixes?.length) {
    parts.push(`<details><summary>Fixed by the bot (${state.fixes.length})</summary>`, "",
      ...state.fixes.map((fix) => `- [\`${fix.sha.slice(0, 7)}\`](${fix.url}) ${fix.commit}: ${fix.why}`), "", "</details>", "");
  }
  if (state.notes?.length) {
    parts.push("<details><summary>Review notes and assumptions</summary>", "",
      ...state.notes.map((note) => `- ${note}`), "", "</details>", "");
  }

  let body = parts.join("\n").trimEnd();
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n_Truncated: see the workflow run summary._`;
  return `${body}\n\n${encodeState(state)}`;
}

/**
 * Read the bot's summary comment, apply `update(state)`, and write it back,
 * creating the comment on first use. Returns the new state.
 */
export async function readSummary(request, pr, login) {
  const comments = await paginate(request, `issues/${pr}/comments`);
  const existing = findSummary(comments, login);
  return { existing, state: { ...emptyState(), ...(decodeState(existing?.body) ?? {}) } };
}

export async function updateSummary(request, pr, login, update) {
  const { existing, state: previous } = await readSummary(request, pr, login);
  const state = update(previous);
  const body = render(state);
  if (existing) await request(`issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
  else await request(`issues/${pr}/comments`, { method: "POST", body: { body } });
  return state;
}

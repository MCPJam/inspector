#!/usr/bin/env node
/**
 * Publish the triage: commit each autofix to the PR branch as its own commit,
 * push, then post one COMMENT review on the new head with the suggestions and
 * the items that need a decision inline, and everything else in the body.
 *
 * Edits go through git plumbing (blob, index, commit), never the working tree,
 * so a path the PR made a symlink cannot redirect a write.
 *
 * Env: GITHUB_TOKEN (the bot's app token), GITHUB_REPOSITORY, APP_SLUG,
 * STATE_DIR, REPO_DIR. Reads `gate.json` and `triage.json`.
 */
import { appendFileSync } from "node:fs";
import {
  AUTOFIX_TRAILER, PHASES, githubClient, gitIn, isEntrypoint, itemMarker, paginate, phaseMarker,
  readBlob, readState, requireEnv, runEntrypoint,
} from "./review-common.mjs";
import { applyEdit, locate } from "./review-triage.mjs";

const MAX_BODY = 60_000;

/** RIGHT-side line ranges GitHub shows for a file in the PR diff, where comments may go. */
export function hunkRanges(diff) {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map(([, start, count = "1"]) => ({ start: Number(start), end: Number(start) + Number(count) - 1 }))
    .filter((range) => range.end >= range.start);
}

const fence = (body) => "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(([run]) => run.length + 1)));

function itemLines(item) {
  const heading = item.category === "suggest" ? "Suggested change" : "Needs a decision";
  const lines = [`**${heading}: ${item.title}**`, "", item.why];
  if (item.downgraded) lines.push("", `_Not committed automatically: ${item.downgraded}._`);
  if (item.category === "discuss" && item.options.length) {
    lines.push("", "**Options**", ...item.options.map((option, index) => `${index + 1}. ${option}`));
  }
  return lines;
}

export function commentBody(item) {
  const lines = itemLines(item);
  if (item.category === "suggest") {
    const marks = fence(item.replace);
    lines.push("", `${marks}suggestion`, ...(item.replace === "" ? [] : [item.replace]), marks);
  }
  return [...lines, "", itemMarker(item)].join("\n");
}

function bodyEntry(item) {
  const lines = [`#### ${item.path ? `\`${item.path}\`` : "General"}`, ...itemLines(item)];
  if (item.find || item.replace) {
    const change = item.category === "suggest"
      ? [...item.find.split("\n").map((line) => `-${line}`), ...(item.replace ? item.replace.split("\n").map((line) => `+${line}`) : [])]
      : item.find.split("\n");
    const marks = fence(change.join("\n"));
    lines.push("", `${marks}${item.category === "suggest" ? "diff" : ""}`, ...change, marks);
  }
  return [...lines, itemMarker(item)].join("\n");
}

export function reviewBody({ gate, triage, autofixed, inline, unplaced, commitUrl }) {
  const phase = PHASES.find((entry) => entry.id === gate.phase);
  const parts = [`## Review pipeline: ${phase.name}`, "", triage.summary];
  if (triage.verdict && triage.verdict !== "FAILED") parts.push("", `Verdict: **${triage.verdict}**`);
  if (autofixed.length) {
    parts.push("", `**Autofixed** in ${autofixed.length} commit${autofixed.length === 1 ? "" : "s"} on this branch:`,
      ...autofixed.map((item) => `- [\`${item.sha.slice(0, 7)}\`](${commitUrl(item.sha)}) ${item.commit}: ${item.why}`));
  }
  const suggestions = inline.filter((item) => item.category === "suggest").length;
  const decisions = inline.length - suggestions;
  if (inline.length) {
    parts.push("", `Inline: ${suggestions} suggestion${suggestions === 1 ? "" : "s"} to accept or dismiss, ` +
      `${decisions} item${decisions === 1 ? "" : "s"} that need${decisions === 1 ? "s" : ""} a decision.`);
  }
  if (unplaced.length) parts.push("", "### Not on a changed line", "", ...unplaced.map(bodyEntry));
  if (triage.notes?.length) {
    parts.push("", "<details><summary>Notes and assumptions</summary>", "", ...triage.notes.map((note) => `- ${note}`), "", "</details>");
  }
  let body = parts.join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n_Truncated: see the workflow run summary._`;
  return `${body}\n\nReviewed commit: ${gate.sha}\n\n${phaseMarker(gate.phase, gate.sha)}`;
}

/** Commit each autofix on top of HEAD. One that no longer applies becomes a suggestion. */
export function commitAutofixes(items, { runGit, phase, identity }) {
  const as = ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
  return items.map((item) => {
    if (item.category !== "autofix") return item;
    const blob = readBlob(runGit, "HEAD", item.path);
    const next = blob && applyEdit(blob.content, item.find, item.replace);
    if (next === null || next === undefined) {
      return { ...item, category: "suggest", downgraded: "an earlier fix changed these lines" };
    }
    const hash = runGit(["hash-object", "-w", "--stdin"], next).trim();
    runGit(["update-index", "--cacheinfo", `${blob.mode},${hash},${item.path}`]);
    runGit([...as, "commit", "-q", "--no-verify", "-m", `${item.commit}\n\n${AUTOFIX_TRAILER}: ${phase}`]);
    return { ...item, sha: runGit(["rev-parse", "HEAD"]).trim() };
  });
}

/** Split comment items into inline comments and body entries, dropping ones posted before. */
export function placeItems(items, { runGit, base, head, posted }) {
  const inline = [];
  const unplaced = [];
  for (const item of items) {
    if (item.category === "autofix" || posted.has(itemMarker(item))) continue;
    const content = item.path ? readBlob(runGit, head, item.path)?.content : null;
    const range = content ? locate(content, item.find) : null;
    const hunks = range ? hunkRanges(runGit(["diff", "--no-ext-diff", "--no-renames", base, head, "--", `:(literal)${item.path}`])) : [];
    const hunk = range && hunks.find((entry) => entry.start <= range.start && range.end <= entry.end);
    (hunk ? inline : unplaced).push(hunk ? { ...item, range } : item);
  }
  return { inline, unplaced };
}

const toComment = (item) => ({
  path: item.path, side: "RIGHT", line: item.range.end, body: commentBody(item),
  ...(item.range.start < item.range.end ? { start_line: item.range.start, start_side: "RIGHT" } : {}),
});

async function postedMarkers(request, pr) {
  const [reviews, comments] = await Promise.all([
    paginate(request, `pulls/${pr}/reviews`), paginate(request, `pulls/${pr}/comments`),
  ]);
  const bodies = [...reviews, ...comments].filter((entry) => entry.user?.type === "Bot").map((entry) => entry.body ?? "");
  return new Set(bodies.flatMap((body) => body.match(/<!-- review-pipeline-item:[0-9a-f]+ -->/g) ?? []));
}

export async function publish({ gate, triage, request, runGit, push, identity, commitUrl }) {
  const current = await request(`pulls/${gate.pr}`);
  if (current.state !== "open" || current.head.sha !== gate.sha) {
    return { skipped: "The PR changed during the run; the new head gets its own run." };
  }
  const items = commitAutofixes(triage.items, { runGit, phase: gate.phase, identity });
  const autofixed = items.filter((item) => item.sha);
  if (autofixed.length) push(gate.headRef);
  const head = runGit(["rev-parse", "HEAD"]).trim();
  const posted = await postedMarkers(request, gate.pr);
  const { inline, unplaced } = placeItems(items, { runGit, base: gate.mergeBase, head, posted });
  const body = reviewBody({ gate, triage, autofixed, inline, unplaced, commitUrl });
  const review = { commit_id: head, event: "COMMENT", body, comments: inline.map(toComment) };
  try {
    await request(`pulls/${gate.pr}/reviews`, { method: "POST", body: review });
  } catch (error) {
    // GitHub rejects the whole review when one comment's lines fall outside
    // its diff view. Post every item in the body instead of losing them.
    if (!/HTTP 422/.test(error.message)) throw error;
    const fallback = reviewBody({ gate, triage, autofixed, inline: [], unplaced: [...inline, ...unplaced], commitUrl });
    await request(`pulls/${gate.pr}/reviews`, { method: "POST", body: { commit_id: head, event: "COMMENT", body: fallback } });
  }
  return { body, autofixed: autofixed.length, inline: inline.length, unplaced: unplaced.length };
}

async function botIdentity(slug) {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not look up ${slug}[bot]: HTTP ${response.status}`);
  const { id } = await response.json();
  return { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` };
}

export async function main() {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "APP_SLUG", "STATE_DIR", "REPO_DIR"]);
  const gate = readState("gate");
  const triage = readState("triage");
  const runGit = gitIn(process.env.REPO_DIR);
  const auth = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
  const push = (ref) => runGit(["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
    "push", "-q", "origin", `HEAD:refs/heads/${ref}`]);
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const result = await publish({
    gate, triage, runGit, push, request: githubClient(),
    identity: await botIdentity(process.env.APP_SLUG),
    commitUrl: (sha) => `${server}/${process.env.GITHUB_REPOSITORY}/pull/${gate.pr}/commits/${sha}`,
  });
  if (result.skipped) {
    console.log(`::notice::${result.skipped}`);
    return;
  }
  console.log(`Posted: ${result.autofixed} autofixes, ${result.inline} inline, ${result.unplaced} in the body.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.body);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);

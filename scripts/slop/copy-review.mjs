#!/usr/bin/env node
/**
 * Claude review of the user-facing copy a PR adds.
 *
 * `rules.mjs` catches dashes, filler and vague errors by regex. Tone, a
 * missing next step and over-explaining need a reader, so:
 *
 *   1. `ui-strings.mjs` lists the copy the change added: strings in the
 *      working tree that were not at `--base`, by file and line.
 *   2. Claude Haiku 5.5 names the pattern in each string that has one,
 *      against `.agents/skills/ui-copy/SKILL.md`, the rubric Claude Code,
 *      Codex and Cursor load as the `ui-copy` skill.
 *   3. Claude Sonnet 5.5 rewrites only the flagged strings.
 *   4. The rewrites go on the PR as one-click suggestions, and the check
 *      fails unless the `slop-waiver` label is set.
 *
 *   node scripts/slop/copy-review.mjs --base HEAD^1
 *   node scripts/slop/copy-review.mjs --dry-run      # print, post nothing
 *
 * Env: ANTHROPIC_API_KEY; GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER and
 * HEAD_SHA to post; SLOP_WAIVER=true to report and pass.
 *
 * Plain `fetch`, no SDK: this runs in CI without `npm ci`, like the ratchet.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changedPaths } from "./ratchet.mjs";
import { addedCopy, isUiFile } from "./ui-strings.mjs";

export const MODELS = {
  classify: { id: "claude-haiku-5-5", input: 0.1, output: 0.5 },
  rewrite: { id: "claude-sonnet-5-5", input: 2, output: 10 },
};

const RUBRIC_PATH = ".agents/skills/ui-copy/SKILL.md";
const MAX_STRINGS = 150;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function readAtBase(base, path) {
  try {
    return git(["show", `${base}:${path}`]);
  } catch {
    // Added since the base: nothing to compare with.
    return "";
  }
}

/** Copy the change added, with the source line each string starts on. */
export function collectAdded(base) {
  const items = [];
  for (const path of changedPaths(base).filter(isUiFile)) {
    if (!existsSync(path)) continue;
    const after = readFileSync(path, "utf8");
    const lines = after.split("\n");
    for (const { line, text } of addedCopy(readAtBase(base, path), after)) {
      items.push({ id: items.length + 1, path, line, text, source: lines[line - 1] ?? "" });
    }
  }
  return items;
}

/** The skill body without its front matter: the same text the editors load. */
export function rubric(path = RUBRIC_PATH) {
  return readFileSync(path, "utf8").replace(/^---[\s\S]*?\n---\n/, "");
}

const schema = (properties) => ({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  },
  required: ["items"],
  additionalProperties: false,
});

/** One structured-output call. Returns the parsed JSON and the usage. */
export async function callClaude({ model, system, user, format, effort }, fetchImpl = fetch) {
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema: format } },
    }),
  });
  if (!response.ok) {
    throw new Error(`${model.id}: HTTP ${response.status} ${await response.text()}`);
  }
  const message = await response.json();
  if (message.stop_reason === "refusal") {
    throw new Error(`${model.id} declined the request (${message.stop_details?.category ?? "refusal"}).`);
  }
  const text = message.content.find((block) => block.type === "text")?.text ?? "{}";
  return { items: JSON.parse(text).items ?? [], usage: message.usage };
}

export async function classify(items, rubricText, call) {
  return call({
    model: MODELS.classify,
    effort: "low",
    system: `${rubricText}\n\nYou are doing the Detect job on strings a pull request added to the UI. Report only strings that match a pattern from the table, using the pattern's exact name. A string that matches nothing is not reported.`,
    user: JSON.stringify(items.map(({ id, path, text }) => ({ id, path, text }))),
    format: schema({ id: { type: "integer" }, pattern: { type: "string" }, note: { type: "string" } }),
  });
}

export async function rewrite(flagged, rubricText, call) {
  return call({
    model: MODELS.rewrite,
    effort: "medium",
    system: `${rubricText}\n\nYou are doing the Rewrite job. For each string, return the replacement copy only, with no quotes around it, keeping every \${placeholder} exactly as written.`,
    user: JSON.stringify(flagged.map(({ id, path, text, pattern, note }) => ({ id, path, text, pattern, note }))),
    format: schema({ id: { type: "integer" }, text: { type: "string" } }),
  });
}

/** The source line with the old copy swapped for the new, or null when it spans lines. */
export function suggestion(source, oldText, newText) {
  return source.includes(oldText) ? source.replace(oldText, newText) : null;
}

export function marker({ path, text }) {
  return `<!-- ui-copy ${createHash("sha1").update(`${path}\n${text}`).digest("hex").slice(0, 12)} -->`;
}

export function commentBody(finding) {
  const fix = suggestion(finding.source, finding.text, finding.rewrite);
  const lines = [`**${finding.pattern}**: ${finding.note}`, ""];
  if (fix) lines.push("```suggestion", fix, "```");
  else lines.push(`Suggested copy: ${finding.rewrite}`);
  lines.push("", marker(finding));
  return lines.join("\n");
}

async function github(path, init, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

/** Post one review with a comment per finding, skipping ones already posted. */
export async function postReview(findings, fetchImpl = fetch) {
  const { GITHUB_REPOSITORY: repo, PR_NUMBER: pr, HEAD_SHA: sha } = process.env;
  const existing = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await github(`/repos/${repo}/pulls/${pr}/comments?per_page=100&page=${page}`, {}, fetchImpl);
    existing.push(...batch.map((comment) => comment.body ?? ""));
    if (batch.length < 100) break;
  }
  const fresh = findings.filter((finding) => !existing.some((body) => body.includes(marker(finding))));
  if (!fresh.length) return 0;
  const review = { commit_id: sha, event: "COMMENT", body: "UI copy review: each comment names the pattern and suggests a rewrite." };
  const comments = fresh.map((finding) => ({ path: finding.path, line: finding.line, side: "RIGHT", body: commentBody(finding) }));
  try {
    await github(`/repos/${repo}/pulls/${pr}/reviews`, { method: "POST", body: JSON.stringify({ ...review, comments }) }, fetchImpl);
  } catch (error) {
    // A line outside the diff (the merge commit renumbered it) makes the
    // whole review a 422. Post the same findings in the review body instead.
    if (!/HTTP 422/.test(error.message)) throw error;
    const body = comments.map((comment) => `\`${comment.path}:${comment.line}\`\n${comment.body}`).join("\n\n");
    await github(`/repos/${repo}/pulls/${pr}/reviews`, { method: "POST", body: JSON.stringify({ ...review, body: `${review.body}\n\n${body}` }) }, fetchImpl);
  }
  return fresh.length;
}

function cost(usage, model) {
  if (!usage) return 0;
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return (input * model.input + (usage.output_tokens ?? 0) * model.output) / 1e6;
}

export function report({ items, findings, usd, waived, posted }) {
  const lines = ["## UI copy review", ""];
  if (!items.length) lines.push("No new user-facing copy in this change.");
  else if (!findings.length) lines.push(`${items.length} new strings, none matched a pattern.`);
  else {
    lines.push(`${findings.length} of ${items.length} new strings matched a pattern.`, "", "| Where | Pattern | Copy | Suggested |", "|---|---|---|---|");
    for (const f of findings) lines.push(`| \`${f.path}:${f.line}\` | ${f.pattern} | ${f.text} | ${f.rewrite} |`);
    lines.push("", waived ? "Waived by the `slop-waiver` label." : `${posted} suggestions posted on the PR. Accept them, or a CODEOWNER can apply \`slop-waiver\` with a reason.`);
  }
  if (usd) lines.push("", `Review cost: about $${usd.toFixed(3)}.`);
  const text = lines.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return findings.length > 0 && !waived ? 1 : 0;
}

export async function main(argv, call = callClaude) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex !== -1 ? argv[baseIndex + 1] : git(["merge-base", "HEAD", "origin/main"]).trim();
  const dryRun = argv.includes("--dry-run");
  const waived = process.env.SLOP_WAIVER === "true";
  const items = collectAdded(base);
  if (!items.length) return report({ items, findings: [], usd: 0, waived, posted: 0 });
  if (items.length > MAX_STRINGS) {
    console.log(`::warning::${items.length} new strings; reviewing the first ${MAX_STRINGS}. Split the PR.`);
    items.length = MAX_STRINGS;
  }
  const text = rubric();
  const classified = await classify(items, text, call);
  let usd = cost(classified.usage, MODELS.classify);
  const byId = new Map(items.map((item) => [item.id, item]));
  let findings = classified.items.filter((f) => byId.has(f.id)).map((f) => ({ ...byId.get(f.id), pattern: f.pattern, note: f.note }));
  if (findings.length) {
    const rewritten = await rewrite(findings, text, call);
    usd += cost(rewritten.usage, MODELS.rewrite);
    const rewrites = new Map(rewritten.items.map((r) => [r.id, r.text]));
    findings = findings.map((f) => ({ ...f, rewrite: rewrites.get(f.id) ?? f.text }));
  }
  const posted = findings.length && !dryRun && process.env.PR_NUMBER ? await postReview(findings) : 0;
  return report({ items, findings, usd, waived, posted });
}

// Compared as URLs: on Windows argv[1] is a `C:\` path, not a `file:` URL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    }
  );
}

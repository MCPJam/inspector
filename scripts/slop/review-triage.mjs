#!/usr/bin/env node
/**
 * Triage: Claude sorts each piece of phase feedback into autofix, suggest or
 * discuss, and writes the edit for the first two. Every edit is then checked
 * here against the head blob: an autofix that cannot be applied exactly, or
 * that touches a path the bot may not change, becomes a suggestion; a
 * suggestion that cannot be placed becomes a discussion.
 *
 * Env: ANTHROPIC_API_KEY, STATE_DIR, REPO_DIR. Reads `gate.json` and
 * `feedback.json`, writes `triage.json`.
 */
import { fileURLToPath } from "node:url";
import { callClaude, MODELS, rubric } from "./copy-review.mjs";
import {
  MAX_AUTOFIXES, gitIn, isEntrypoint, readBlob, readState, requireEnv, runEntrypoint, writeState,
} from "./review-common.mjs";

const PROMPT = fileURLToPath(new URL("./review-triage.md", import.meta.url));
const CATEGORIES = ["autofix", "suggest", "discuss"];
const text = { type: "string" };
const FORMAT = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          feedback: { type: "integer" },
          category: { type: "string", enum: CATEGORIES },
          title: text, path: text, find: text, replace: text, why: text, commit: text,
          options: { type: "array", items: text },
        },
        required: ["feedback", "category", "title", "path", "find", "replace", "why", "options", "commit"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/**
 * Paths the bot never commits to, even when the PR changed them: CI and its
 * own gate; files that run code on CI or on developers' machines (package
 * scripts, git hooks, agent hooks); lockfiles, built and generated files.
 */
const NO_AUTOFIX = [
  /^\.github\//, /^scripts\/slop\//, /^scripts\/git-hooks\//, /^\.claude\//, /^\.agents\//,
  /(^|\/)package\.json$/, /(^|\/)package-lock\.json$/, /(^|\/)dist\//,
  /^DESIGN\.md$/, /^docs\/style\.css$/, /^docs\/docs\.json$/, /^chat-ui\/src\/styles\.css$/,
];
export const autofixAllowedFor = (path) => !NO_AUTOFIX.some((pattern) => pattern.test(path));

const splitLines = (value) => value.replace(/\n$/, "").split("\n");

/** 1-based line range where `find` occurs as whole lines, or null unless exactly once. */
export function locate(content, find) {
  if (!find.trim()) return null;
  const lines = content.split("\n");
  const needle = splitLines(find);
  const starts = [];
  for (let index = 0; index + needle.length <= lines.length; index++) {
    if (needle.every((line, offset) => lines[index + offset] === line)) starts.push(index);
  }
  return starts.length === 1 ? { start: starts[0] + 1, end: starts[0] + needle.length } : null;
}

/** `content` with the lines of `find` replaced by `replace`, or null when `find` is not unique. */
export function applyEdit(content, find, replace) {
  const range = locate(content, find);
  if (!range) return null;
  const lines = content.split("\n");
  lines.splice(range.start - 1, range.end - range.start + 1, ...(replace === "" ? [] : splitLines(replace)));
  return lines.join("\n");
}

const subject = (item) =>
  (item.commit.split("\n")[0].trim() || `Fix ${item.title}`).slice(0, 72);

/**
 * Enforce what the prompt asks for. `readFile(path)` returns head content or
 * null. Autofixes are capped, only touch files in `changed` (the PR's own
 * diff, never a file a CI log merely names), and only run when the gate allows
 * them: in suggest mode, or after the autofix limit, every autofix becomes a
 * suggestion.
 */
export function validate(items, { readFile, changed, autofix, autofixReason = "" }) {
  let autofixes = 0;
  // Accepted autofix line ranges per path. Edits are applied one after another,
  // so a later edit overlapping an earlier one could match the earlier edit's
  // output and commit a change neither proposed.
  const accepted = new Map();
  return items.map((raw) => {
    const item = { ...raw, path: raw.path.trim(), downgraded: "" };
    const content = item.path ? readFile(item.path) : null;
    const range = content === null ? null : locate(content, item.find);
    const placed = range !== null;
    if (item.category === "autofix") {
      const earlier = accepted.get(item.path) ?? [];
      const reason = !autofix ? autofixReason || "autofix is off for this run"
        : autofixes >= MAX_AUTOFIXES ? `at most ${MAX_AUTOFIXES} autofixes run at once`
        : !changed.has(item.path) ? "the bot only commits to files this PR changed"
        : !autofixAllowedFor(item.path) ? "the bot does not commit to this path"
        : !placed || item.replace === item.find ? "the edit did not apply cleanly"
        : earlier.some((prior) => prior.start <= range.end && range.start <= prior.end)
          ? "the edit overlaps an earlier autofix"
        : "";
      if (!reason) {
        autofixes++;
        accepted.set(item.path, [...earlier, range]);
        return { ...item, commit: subject(item) };
      }
      item.category = "suggest";
      item.downgraded = reason;
    }
    if (item.category === "suggest" && (!placed || item.replace === item.find)) {
      item.category = "discuss";
      item.downgraded ||= "the suggested change could not be placed on a line";
      item.options = item.options.length ? item.options : [`Apply this change by hand:\n\n${item.replace}`];
    }
    if (item.category === "discuss" && !placed) item.find = "";
    return item;
  });
}

export async function triage({ gate, feedback, readFile, call = callClaude }) {
  if (feedback.items.length === 0) return [];
  const { items } = await call({
    model: MODELS.rewrite,
    effort: "medium",
    system: rubric(PROMPT),
    user: JSON.stringify({
      phase: feedback.phase,
      autofixAllowed: gate.autofix,
      feedback: feedback.items.map((item, index) => ({ index, ...item })),
      files: feedback.files,
    }),
    format: FORMAT,
  });
  const known = items.filter((item) => CATEGORIES.includes(item.category));
  const changed = new Set(feedback.files.filter((file) => file.diff).map((file) => file.path));
  return validate(known, { readFile, changed, autofix: gate.autofix, autofixReason: gate.autofixReason });
}

export async function main() {
  requireEnv(["STATE_DIR", "REPO_DIR"]);
  const gate = readState("gate");
  const feedback = readState("feedback");
  if (feedback.items.length) requireEnv(["ANTHROPIC_API_KEY"]);
  const runGit = gitIn(process.env.REPO_DIR);
  const readFile = (path) => readBlob(runGit, gate.sha, path)?.content ?? null;
  const items = await triage({ gate, feedback, readFile });
  const { files, ...rest } = feedback;
  writeState("triage", { ...rest, items });
  const counts = CATEGORIES.map((category) => `${items.filter((item) => item.category === category).length} ${category}`);
  console.log(`Triage: ${counts.join(", ")}.`);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);

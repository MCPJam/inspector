/**
 * Phase 3 of the review pipeline: the adversarial review of a PR whose checks
 * passed. Returns structured findings; `review-triage.mjs` decides what to do
 * with each one. The PR is data: blobs are read from git, nothing is run.
 */
import { fileURLToPath } from "node:url";
import { callClaude, MODELS, rubric } from "./copy-review.mjs";

const MAX_CONTEXT_BYTES = 500_000;
const PROMPT = fileURLToPath(new URL("./adversarial-review.md", import.meta.url));
const text = { type: "string" };
const FORMAT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["BLOCK", "CONCERNS", "CLEAN"] },
    summary: text,
    notes: { type: "array", items: text },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "warning", "note"] },
          title: text, path: text, snippet: text, problem: text, fix: text, test: text,
          personas: { type: "array", items: text },
        },
        required: ["severity", "title", "path", "snippet", "problem", "fix", "test", "personas"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "notes", "items"],
  additionalProperties: false,
};

/** The PR cannot be reviewed within the budget. The run skips; nothing is wrong with the PR. */
export class ReviewBudgetError extends Error {}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

/**
 * Read blobs, never working-tree files or symlink targets supplied by a PR.
 * Every file's diff is always sent. Whole files are added smallest first while
 * they fit; a file left out is marked `diffOnly`, and the review names it.
 */
export function collectContext(base, head, runGit) {
  const paths = runGit(["diff", "--name-only", "--no-renames", "-z", base, head, "--"])
    .split("\0").filter(Boolean);
  const full = paths.map((path) => {
    const versions = [base, head].map((ref) => {
      const entry = runGit(["ls-tree", ref, "--", `:(literal)${path}`]);
      if (!entry) return null;
      if (!/^100(?:644|755) blob /.test(entry)) return "[non-regular file omitted]";
      const content = runGit(["show", `${ref}:${path}`]);
      return content.includes("\0") ? "[binary file omitted]" : content;
    });
    const diff = runGit(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", `:(literal)${path}`]);
    return { path, before: versions[0], after: versions[1], diff };
  });
  const omitted = (version) => version === null ? null : "[full file omitted to fit the review budget]";
  const files = full.map((file) => ({ ...file, before: omitted(file.before), after: omitted(file.after), diffOnly: true }));
  let bytes = files.reduce((total, file) => total + jsonBytes(file), 0);
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new ReviewBudgetError("The diff alone is over the 500 KB review budget, so it was not reviewed. Split the PR or review it manually.");
  }
  const bySize = full.map((file, index) => ({ index, extra: jsonBytes(file) - jsonBytes(files[index]) }))
    .sort((a, b) => a.extra - b.extra);
  for (const { index, extra } of bySize) {
    if (bytes + extra > MAX_CONTEXT_BYTES) break;
    files[index] = full[index];
    bytes += extra;
  }
  return files;
}


/**
 * Review the PR between `base` (the merge base) and `head`. A PR over the
 * budget comes back as a SKIPPED verdict with no findings rather than an error:
 * nothing is wrong with the PR, it is only too large to review in one call.
 */
export async function runReview({ base, head, runGit, call = callClaude }) {
  let files;
  try {
    files = collectContext(base, head, runGit);
  } catch (error) {
    if (!(error instanceof ReviewBudgetError)) throw error;
    return { verdict: "SKIPPED", summary: error.message, notes: [], findings: [], files: [] };
  }
  const diffOnly = files.filter((file) => file.diffOnly).map((file) => file.path);
  const { result } = await call({
    model: MODELS.rewrite,
    effort: "high",
    system: rubric(PROMPT),
    user: JSON.stringify({
      files,
      limitations: "Only changed files are supplied; binary and non-regular blobs are marked as omitted. " +
        "Files marked diffOnly carry only their diff, because their whole contents did not fit the review budget.",
    }),
    format: FORMAT,
  });
  if (!result || typeof result.summary !== "string" || !Array.isArray(result.items)) {
    throw new Error("Claude returned an invalid review.");
  }
  const notes = [...result.notes];
  if (diffOnly.length) notes.push(`Reviewed from the diff only, because the whole file did not fit the review budget: ${diffOnly.map((path) => `\`${path}\``).join(", ")}`);
  return { verdict: result.verdict, summary: result.summary, notes, findings: result.items, files };
}

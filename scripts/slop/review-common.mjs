/**
 * Shared pieces of the PR review pipeline (`.github/workflows/adversarial-review.yml`).
 *
 * A PR opens as a draft and moves through PHASES in order. The first phase
 * that fails, or the adversarial review once everything passes, is triaged:
 * each piece of feedback becomes an autofix commit, or an entry for a person to
 * decide in the pipeline's one summary comment. When the bot has nothing left
 * to fix, it marks the PR ready, which requests the code owners, and assigns
 * one of them. The steps hand their results to each other as JSON in STATE_DIR.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PHASES = [
  { id: "ci", name: "Tests and build", workflows: ["test.yml", "lint.yml"] },
  { id: "quality", name: "Quality checks", workflows: ["pr-size.yml", "ui-copy-review.yml", "slop-ratchet.yml"] },
  { id: "review", name: "Adversarial review", workflows: [] },
];
export const AUTOFIX_TRAILER = "Review-Pipeline-Autofix";
/** Bot commits in a row at the PR tip before the bot stops pushing and hands over. */
export const MAX_AUTOFIX_ROUNDS = 3;
export const MAX_AUTOFIXES = 10;
/** A PR with this label is reviewed and fixed but never marked ready or assigned. */
export const HOLD_LABEL = "wip";

/** Starts the pipeline's one comment on a PR. Only the bot's own copy counts. */
export const SUMMARY_MARKER = "<!-- review-pipeline-summary -->";
const STATE_PATTERN = /<!-- review-pipeline-state:([A-Za-z0-9+/=]*) -->/;

/** The state block a summary comment carries, so the next run can rebuild the comment. */
export function encodeState(state) {
  return `<!-- review-pipeline-state:${Buffer.from(JSON.stringify(state)).toString("base64")} -->`;
}

export function decodeState(body) {
  const match = STATE_PATTERN.exec(body ?? "");
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    // A corrupt block starts the comment over; it never blocks the pipeline.
    return null;
  }
}

/** The bot's summary comment among a PR's issue comments, or undefined. */
export function findSummary(comments, login) {
  return comments.find((comment) => comment.body?.startsWith(SUMMARY_MARKER) &&
    (login ? comment.user?.login === login : comment.user?.type === "Bot"));
}

/** A GitHub GraphQL call with the same token as the REST client. */
export function graphqlClient(token = process.env.GITHUB_TOKEN) {
  return async (query, variables) => {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL: HTTP ${response.status}`);
    const result = await response.json();
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors[0].message}`);
    return result.data;
  };
}

export const phaseMarker = (phase, sha) => `<!-- review-pipeline:${phase}:${sha} -->`;

export function requireEnv(names) {
  for (const name of names) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
}

export function gitIn(dir) {
  return (args, input) => execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input,
  });
}

/** Regular-file content at `ref`, or null for a missing, binary or non-regular path. */
export function readBlob(runGit, ref, path) {
  const entry = runGit(["ls-tree", ref, "--", `:(literal)${path}`]);
  const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
  if (!match) return null;
  const content = runGit(["cat-file", "blob", match[2]]);
  return content.includes("\0") ? null : { mode: match[1], content };
}

/** A GitHub REST client scoped to this repository. `raw` returns the body as text. */
export function githubClient(token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY) {
  return async (path, { method = "GET", body, raw = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
    return raw ? response.text() : response.json();
  };
}

/** Every page of a list endpoint. `pick` extracts the array from wrapped responses. */
export async function paginate(request, path, pick = (page) => page, maxPages = 10) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = pick(await request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

export function readState(name) {
  return JSON.parse(readFileSync(join(process.env.STATE_DIR, `${name}.json`), "utf8"));
}

export function writeState(name, value) {
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  writeFileSync(join(process.env.STATE_DIR, `${name}.json`), JSON.stringify(value, null, 2));
}

export function isEntrypoint(url) {
  return process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;
}

export function runEntrypoint(main) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

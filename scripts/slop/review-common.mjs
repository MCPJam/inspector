/**
 * Shared pieces of the PR review pipeline (`.github/workflows/adversarial-review.yml`).
 *
 * A PR moves through PHASES in order. The first phase that fails, or the
 * adversarial review once everything passes, is triaged: each piece of
 * feedback becomes an autofix commit, a suggestion, or a comment for a person
 * to decide. The steps hand their results to each other as JSON in STATE_DIR.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PHASES = [
  { id: "ci", name: "Tests and build", workflows: ["test.yml", "lint.yml"] },
  { id: "quality", name: "Quality checks", workflows: ["pr-size.yml", "ui-copy-review.yml", "slop-ratchet.yml"] },
  { id: "review", name: "Adversarial review", workflows: [] },
];
export const AUTOFIX_TRAILER = "Review-Pipeline-Autofix";
/** Bot commits in a row at the PR tip before the bot stops pushing and only suggests. */
export const MAX_AUTOFIX_ROUNDS = 2;
export const MAX_AUTOFIXES = 5;

export const phaseMarker = (phase, sha) => `<!-- review-pipeline:${phase}:${sha} -->`;
export const itemMarker = (item) => `<!-- review-pipeline-item:${createHash("sha256")
  .update(JSON.stringify([item.category, item.path, item.find])).digest("hex").slice(0, 16)} -->`;

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

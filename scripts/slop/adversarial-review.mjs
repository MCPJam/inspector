#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callClaude, MODELS, rubric } from "./copy-review.mjs";

const MAX_CONTEXT_BYTES = 500_000;
const PROMPT = fileURLToPath(new URL("./adversarial-review.md", import.meta.url));
const FORMAT = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/** Read blobs, never working-tree files or symlink targets supplied by a PR. */
export function collectContext(base, head, runGit = git) {
  const paths = runGit(["diff", "--name-only", "--no-renames", "-z", base, head, "--"])
    .split("\0").filter(Boolean);
  const files = [];
  let bytes = 0;
  for (const path of paths) {
    const versions = [base, head].map((ref) => {
      const entry = runGit(["ls-tree", ref, "--", `:(literal)${path}`]);
      if (!entry) return null;
      if (!/^100(?:644|755) blob /.test(entry)) return "[non-regular file omitted]";
      const content = runGit(["show", `${ref}:${path}`]);
      return content.includes("\0") ? "[binary file omitted]" : content;
    });
    const diff = runGit(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", `:(literal)${path}`]);
    const file = { path, before: versions[0], after: versions[1], diff };
    bytes += Buffer.byteLength(JSON.stringify(file));
    if (bytes > MAX_CONTEXT_BYTES) throw new Error("PR exceeds the 500 KB review budget; split the PR or review manually. No review posted.");
    files.push(file);
  }
  return files;
}

export function reviewBody(items, sha) {
  if (!Array.isArray(items) || items.length !== 1 || typeof items[0]?.body !== "string" ||
      !/\[(do|try|nit)\]/.test(items[0].body) || items[0].body.length > 25_000) {
    throw new Error("Claude returned an invalid review body.");
  }
  return `${items[0].body}\n\nReviewed commit: ${sha}\n\n<!-- adversarial-review:${sha} -->`;
}

async function github(path, method = "GET", body) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub review request failed: HTTP ${response.status}`);
  return response.json();
}

export async function alreadyReviewed(pr, sha, request = github) {
  for (let page = 1; ; page++) {
    const reviews = await request(`pulls/${pr}/reviews?per_page=100&page=${page}`);
    if (reviews.some((review) => review.user?.login === "github-actions[bot]" &&
        review.body?.includes(`<!-- adversarial-review:${sha} -->`))) return true;
    if (reviews.length < 100) return false;
  }
}

export async function main(call = callClaude, request = github, collect = collectContext) {
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA"]) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  const { PR_NUMBER: pr, HEAD_SHA: sha } = process.env;
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(pr)) throw new Error("Invalid PR number or commit SHA.");
  if (await alreadyReviewed(pr, sha, request)) return;
  const current = await request(`pulls/${pr}`);
  if (current.state !== "open" || current.head.sha !== sha) throw new Error("PR changed before review; rerun on the latest commit.");
  const files = collect("HEAD^1", sha);
  const { items } = await call({
    model: MODELS.rewrite,
    effort: "high",
    system: rubric(PROMPT),
    user: JSON.stringify({ files, limitations: "Only changed files are supplied; binary and non-regular blobs are marked as omitted." }),
    format: FORMAT,
  });
  const body = reviewBody(items, sha);
  const latest = await request(`pulls/${pr}`);
  if (latest.state !== "open" || latest.head.sha !== sha) throw new Error("PR changed during review; no stale review posted.");
  await request(`pulls/${pr}/reviews`, "POST", { commit_id: sha, event: "COMMENT", body });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

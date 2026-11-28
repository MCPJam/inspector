#!/usr/bin/env node
// Fails when a pull request has an unresolved CodeRabbit thread graded Major
// or Critical. CodeRabbit has no setting that turns finding severity into a
// failing check, so this reads the grade line of each finding, e.g.
// "**<picture>…</picture> Major** · **Functional Correctness** · **Quick win**".
// Comments open with an HTML marker and a blank line, so the grade line is the
// first line that is neither.
// Resolving the thread is how a finding stops blocking.

import { pathToFileURL } from "node:url";

const CODERABBIT_LOGINS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const BLOCKING_SEVERITY = /\*\*[^*\n]*\b(Critical|Major)\*\*/;

// A marker can span lines; reading its first line as the grade would let a
// Major finding pass.
function gradeLineIndex(lines) {
  let inMarker = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (inMarker || trimmed.startsWith("<!--")) {
      inMarker = !trimmed.endsWith("-->");
    } else if (trimmed !== "") {
      return index;
    }
  }
  return -1;
}

/** Returns "Critical", "Major" or null for a CodeRabbit comment body. */
export function blockingSeverity(body) {
  const lines = body.split("\n");
  const gradeLine = lines[gradeLineIndex(lines)] ?? "";
  return gradeLine.match(BLOCKING_SEVERITY)?.[1] ?? null;
}

/** Picks the unresolved threads whose opening CodeRabbit finding blocks. */
export function blockingFindings(threads) {
  return threads.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    if (thread.isResolved || !first) return [];
    if (!CODERABBIT_LOGINS.has(first.author?.login ?? "")) return [];
    const severity = blockingSeverity(first.body);
    if (!severity) return [];
    // The bold line under the grade is the finding's headline, when there is one.
    const lines = first.body.split("\n");
    const title = lines.slice(gradeLineIndex(lines) + 1).find((line) => /^\*\*.+\*\*$/.test(line.trim()));
    return [{ severity, path: first.path, url: first.url, title: title?.trim() ?? "" }];
  });
}

const THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 1) { nodes { author { login } body path url } }
          }
        }
      }
    }
  }`;

async function fetchThreads({ token, owner, repo, number }) {
  const threads = [];
  let after = null;
  do {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, repo, number, after } }),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) {
      throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors ?? payload)}`);
    }
    const page = payload.data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return threads;
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and PR_NUMBER are required");
  }
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const threads = await fetchThreads({ token: GITHUB_TOKEN, owner, repo, number: Number(PR_NUMBER) });
  const findings = blockingFindings(threads);
  if (findings.length === 0) {
    process.stdout.write("No unresolved Major or Critical CodeRabbit findings.\n");
    return;
  }
  process.stdout.write(`${findings.length} unresolved Major or Critical CodeRabbit finding(s):\n`);
  for (const f of findings) {
    process.stdout.write(`::error file=${f.path}::${f.severity}: ${f.title} ${f.url}\n`);
  }
  process.stdout.write("Fix each finding, or resolve its thread if it does not apply.\n");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

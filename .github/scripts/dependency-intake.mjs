// A new package deserves a human look before it lands (install scripts, eval
// of input, maintainer health, whether a few lines of our own would do):
// advisory scanners only see known CVEs. So a PR that adds a name to any
// package.json fails until it carries the intake answers and an independent
// approval. Version bumps of listed names do not count, so Dependabot passes.
// Runs on the PR's merge commit, where HEAD^1 is the base branch.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const LABEL = "new-dependency";
const APPROVER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const listed = (pkg) => new Set(FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));

/** Names `head` lists that `base` lists in none of the dependency fields. */
export function addedDependencies(base, head) {
  const before = listed(base);
  return [...listed(head)].filter((name) => !before.has(name)).sort();
}

/** Whether the description, outside HTML comments, has a "Dependency intake:" line. */
export function hasIntakeBlock(body) {
  // An unterminated comment or code fence runs to the end, as in GFM. A fence
  // is matched where it starts, so a "<!--" inside example code stays text.
  // Repeat until nothing changes, so removing one comment cannot join the text
  // around it into another.
  let visible = body ?? "";
  for (let previous; previous !== visible; ) {
    previous = visible;
    visible = visible.replace(
      /^ {0,3}((`|~)\2{2,})[^\n]*[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))|<!--[\s\S]*?(?:-->|(?![\s\S]))/gm,
      (match, fence) => (fence ? match : ""),
    );
  }
  return /^[\s>#*_-]*Dependency intake:/im.test(visible);
}

/**
 * Whether a person other than the author, with write access, approved
 * `headSha` itself. A reviewer's latest non-comment review is their stance, so
 * a later request for changes replaces an approval, and a push needs a fresh one.
 */
export function approvedAtHead(reviews, author, headSha) {
  const stances = new Map();
  // The API lists reviews oldest first.
  for (const review of reviews) {
    if (review.user && review.state !== "COMMENTED") stances.set(review.user.login, review);
  }
  return [...stances.values()].some(
    (r) =>
      r.state === "APPROVED" &&
      r.commit_id === headSha &&
      r.user.type === "User" &&
      r.user.login !== author &&
      APPROVER_ASSOCIATIONS.has(r.author_association),
  );
}

function changedManifests() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  // -z, because without it git quotes unusual paths and a quoted package.json would not match.
  const fields = git("diff", "--name-status", "-z", "-M", "--diff-filter=d", "HEAD^1", "HEAD").split("\0");
  const changes = [];
  for (let i = 0; fields[i]; ) {
    const state = fields[i++];
    const from = fields[i++];
    // A rename or copy record carries the old path and then the new one.
    changes.push({ state, from, to: /^[RC]/.test(state) ? fields[i++] : from });
  }
  const isManifest = (path) => /(^|\/)package\.json$/.test(path);
  return changes
    .filter(({ to }) => isManifest(to))
    .map(({ state, from, to }) => ({
      file: to,
      // A manifest made by renaming another file (a template, say) starts empty.
      added: addedDependencies(
        state === "A" || !isManifest(from) ? {} : JSON.parse(git("show", `HEAD^1:${from}`)),
        JSON.parse(git("show", `HEAD:${to}`)),
      ),
    }))
    .filter((manifest) => manifest.added.length > 0);
}

async function main(env = process.env) {
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  const summary = (text) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  const manifests = changedManifests();
  if (manifests.length === 0) return summary("No new dependencies in this PR.");

  const pr = await api(`/pulls/${env.PR_NUMBER}`);
  // A fork PR's token is read-only; the verdict below still applies.
  const canLabel = pr.head.repo?.full_name === env.GITHUB_REPOSITORY;
  if (canLabel && !pr.labels.some((label) => label.name === LABEL)) {
    await api(`/issues/${pr.number}/labels`, { method: "POST", body: JSON.stringify({ labels: [LABEL] }) });
  }
  const intake = hasIntakeBlock(pr.body);
  // Every page, oldest first, so a request for changes after review 100 still counts.
  const reviews = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/pulls/${pr.number}/reviews?per_page=100&page=${page}`);
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  const approved = approvedAtHead(reviews, pr.user.login, pr.head.sha);
  summary(
    [
      "## New dependencies",
      ...manifests.map(({ file, added }) => `- \`${file}\`: ${added.map((n) => `\`${n}\``).join(", ")}`),
      "",
      `- ${intake ? "Done" : "Missing"}: a "Dependency intake:" block in the PR description answering the checklist (need, install scripts, eval or dynamic code, network and file access, maintainer health, transitive size, licence, advisories, where it runs).`,
      `- ${approved ? "Done" : "Missing"}: an approval from someone other than the author on the latest commit.`,
    ].join("\n"),
  );
  if (!(intake && approved)) {
    console.error("::error::This PR adds dependencies; the job summary lists what the intake still needs.");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The version commit: what Start release (prepare-release.yml) pushes to
 * `main` as the release GitHub App, and what main-push-guard.yml and
 * release-trigger.yml read back.
 *
 * It is the only commit that reaches `main` without a pull request. Every
 * other change arrives through a reviewed PR, so this one may carry nothing
 * but what `changeset version` writes for code already on `main`: package
 * versions and sibling ranges, changelogs, the matching lockfile entries, and
 * the consumed changeset files. `checkVersionCommit` is that rule, and both
 * the push and the guard run it.
 *
 * The release's choices ride in the message as trailers, so release-trigger
 * can retry a release with the options the person who started it chose.
 */

export const RELEASE_COMMIT_PREFIX = "chore(release): version packages";

const OPTION_TRAILERS = [
  ["deploy_backend_prod", "Release-Deploy-Backend-Prod"],
  ["deploy_webapp", "Release-Deploy-Webapp"],
  ["skip_verify", "Release-Skip-Verify"],
];

/** `releases` is `changeset status` output: `{ name, type, newVersion }`. */
export function releaseLabelFromStatus(releases) {
  const bumped = releases.filter((r) => r.type !== "none");
  const inspector = bumped.find((r) => r.name === "@mcpjam/inspector");
  return inspector
    ? inspector.newVersion
    : bumped.map((r) => `${r.name} ${r.newVersion}`).join(", ");
}

export function releaseCommitMessage({ releases, options, requestedBy }) {
  const label = releaseLabelFromStatus(releases);
  const versions = releases
    .filter((r) => r.type !== "none")
    .map((r) => `- ${r.name} ${r.oldVersion} -> ${r.newVersion}`)
    .join("\n");
  const trailers = [
    `Release-Versions: ${label}`,
    ...OPTION_TRAILERS.map(([key, trailer]) => `${trailer}: ${options[key] ? "true" : "false"}`),
    ...(requestedBy ? [`Release-Requested-By: ${requestedBy}`] : []),
  ];
  return `${RELEASE_COMMIT_PREFIX} (${label})\n\n${versions}\n\n${trailers.join("\n")}\n`;
}

/**
 * Reads the trailers back, or null for any other commit. A missing or
 * malformed option reads as false: a deploy nobody asked for must not happen.
 */
export function parseReleaseCommit(message) {
  if (!(message ?? "").startsWith(RELEASE_COMMIT_PREFIX)) return null;
  const trailer = (name) =>
    message.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1].trim() ?? null;
  const label = trailer("Release-Versions");
  if (!label) return null;
  const options = Object.fromEntries(
    OPTION_TRAILERS.map(([key, name]) => [key, trailer(name) === "true"])
  );
  return { label, options, requestedBy: trailer("Release-Requested-By") ?? "" };
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function withoutVersions(entry, workspaceNames) {
  const copy = structuredClone(entry);
  delete copy.version;
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(copy[field] ?? {})) {
      if (workspaceNames.has(name)) delete copy[field][name];
    }
  }
  return copy;
}

/** A package.json minus its version and its ranges on sibling workspaces. */
export function normalizeManifest(text, workspaceNames) {
  return JSON.stringify(withoutVersions(JSON.parse(text), workspaceNames));
}

/**
 * The lockfile minus what a version bump changes: each workspace entry's
 * version and sibling ranges. Third-party entries must match exactly.
 */
export function normalizeLock(text, workspaceNames) {
  const lock = JSON.parse(text);
  delete lock.version;
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    packages[key] = key.includes("node_modules/") ? entry : withoutVersions(entry, workspaceNames);
  }
  return JSON.stringify({ ...lock, packages });
}

const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const MANIFEST = /^(?:[^/]+\/)?package\.json$/;
const CHANGELOG = /(?:^|\/)CHANGELOG\.md$/;

/**
 * Every way `changes` goes beyond a version bump; empty when it does not.
 *
 * @param {{status: string, path: string}[]} changes `git diff --name-status` rows
 * @param {(side: "base" | "head", path: string) => string} read file contents
 * @param {Set<string>} workspaceNames package names of the workspaces
 */
export function checkVersionCommit({ changes, read, workspaceNames }) {
  const problems = [];
  for (const { status, path } of changes) {
    if (status === "D" && CHANGESET.test(path)) continue;
    if (status === "M" && CHANGELOG.test(path)) continue;
    if (status === "M" && MANIFEST.test(path)) {
      if (normalizeManifest(read("base", path), workspaceNames) !== normalizeManifest(read("head", path), workspaceNames))
        problems.push(`${path}: changes more than versions and sibling ranges`);
      continue;
    }
    if (status === "M" && path === "package-lock.json") {
      if (normalizeLock(read("base", path), workspaceNames) !== normalizeLock(read("head", path), workspaceNames))
        problems.push(`${path}: changes more than workspace versions and sibling ranges`);
      continue;
    }
    problems.push(`${path}: a version commit may not ${status === "D" ? "delete" : status === "A" ? "add" : "change"} this file`);
  }
  return problems;
}

/** The workspace package names at `rev`, read from git. */
function workspaceNamesAt(git, rev) {
  const names = new Set();
  for (const dir of JSON.parse(git(["show", `${rev}:package.json`])).workspaces ?? []) {
    names.add(JSON.parse(git(["show", `${rev}:${dir}/package.json`])).name);
  }
  return names;
}

/** `checkVersionCommit` for the diff between two revisions. */
export function checkVersionCommitBetween(base, head, cwd = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const changes = git(["diff", "--name-status", "--no-renames", base, head])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status: status[0], path };
    });
  const revs = { base, head };
  return checkVersionCommit({
    changes,
    read: (side, path) => git(["show", `${revs[side]}:${path}`]),
    workspaceNames: workspaceNamesAt(git, base),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    // node release-commit.mjs check <base> <head>
    const problems = checkVersionCommitBetween(args[0], args[1]);
    for (const problem of problems) console.error(problem);
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (command === "message") {
    // node release-commit.mjs message <changeset status.json>
    const { releases } = JSON.parse(readFileSync(args[0], "utf8"));
    const env = process.env;
    process.stdout.write(
      releaseCommitMessage({
        releases,
        options: {
          deploy_backend_prod: env.DEPLOY_BACKEND_PROD === "true",
          deploy_webapp: env.DEPLOY_WEBAPP === "true",
          skip_verify: env.SKIP_VERIFY === "true",
        },
        requestedBy: env.REQUESTED_BY ?? "",
      })
    );
  } else {
    console.error("usage: release-commit.mjs check <base> <head> | message <status.json>");
    process.exit(2);
  }
}

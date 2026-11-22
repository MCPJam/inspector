/**
 * The Stop hook's lint step: ESLint over the inspector files the turn changed,
 * with the inspector's config and suppressions file, so a baselined violation
 * stays quiet and a new one goes back to the agent before it says it is done.
 *
 * At turn start UserPromptSubmit records HEAD and a content hash of every
 * inspector file that already differs from it, tracked or untracked. At Stop a
 * file counts as the turn's when it differs from that HEAD and its hash is new,
 * so a branch's earlier changes and a person's in-progress edits stay out
 * unless the turn touched them. Anything that keeps ESLint from giving a
 * verdict (no snapshot, no install, a crash, a timeout) lets the turn end with
 * a note saying the check was skipped.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRootFor } from "./hook.mjs";

const INSPECTOR = "mcpjam-inspector";
/** What `npm run lint -w @mcpjam/inspector` covers, by eslint.config.js's `files`. */
const LINTED =
  /^mcpjam-inspector\/(client\/src\/.+\.tsx?|(server|shared)\/.+\.ts)$/;
const LINTED_DIRS = ["client/src", "server", "shared"].map(
  (dir) => `${INSPECTOR}/${dir}`,
);
export const MAX_LINES = 40;
/** The Stop hook gets 30s in `.claude/settings.json`, and the ratchet runs first. */
const TIMEOUT_MS = 20_000;

/** The changed paths ESLint lints, relative to the inspector package. */
export function lintTargets(paths) {
  return [...new Set(paths)]
    .filter((path) => LINTED.test(path))
    .map((path) => path.slice(INSPECTOR.length + 1));
}

export function trimOutput(text, max = MAX_LINES) {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= max) return lines.join("\n");
  return [
    ...lines.slice(0, max),
    `... ${lines.length - max} more lines. Run \`npm run lint -w @mcpjam/inspector\` for the full report.`,
  ].join("\n");
}

/**
 * Whether `output` over the files in `tree` is the report already shown last
 * time, and the fingerprint to remember. The same report on an unchanged tree
 * goes back to the agent once; after that the turn may end.
 */
export function repeatCheck(output, tree, last) {
  const seen = createHash("sha256")
    .update(`${output}\0${tree}`)
    .digest("hex");
  return { repeat: seen === last, seen };
}

/** A per-session, per-checkout file in the temp directory. */
function sessionFile(kind, sessionId, root) {
  const key = createHash("sha256")
    .update(`${sessionId ?? ""}\0${root}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `slop-hook-eslint-${kind}-${key}`);
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Content hashes of the linted files that differ from `head`, untracked ones included. */
function changedHashes(root, head) {
  const tracked = git(
    root,
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    head,
    "--",
    ...LINTED_DIRS,
  ).split("\0");
  const untracked = git(
    root,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...LINTED_DIRS,
  ).split("\0");
  return Object.fromEntries(
    [...new Set([...tracked, ...untracked])]
      .filter((path) => LINTED.test(path) && existsSync(join(root, path)))
      .map((path) => [
        path,
        createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      ]),
  );
}

/** UserPromptSubmit: record what was already changed before the turn. */
export function snapshotTurn(input) {
  try {
    const root = repoRootFor(input.cwd ?? process.cwd());
    if (!root) return 0;
    const head = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(
      sessionFile("turn", input.session_id, root),
      JSON.stringify({ head, files: changedHashes(root, head) }),
    );
  } catch (error) {
    // Stop reports the missing snapshot as a skipped check.
    process.stderr.write(`ESLint turn snapshot failed: ${error.message}\n`);
  }
  return 0;
}

function skipped(detail) {
  process.stderr.write(
    `ESLint Stop check skipped: ${trimOutput(String(detail), 5)}\n`,
  );
  return 0;
}

function lint(input) {
  if (input.stop_hook_active) return 0;
  const root = repoRootFor(input.cwd ?? process.cwd());
  if (!root) return 0;
  const snapshot = sessionFile("turn", input.session_id, root);
  if (!existsSync(snapshot)) {
    return skipped("no turn-start snapshot, so the turn's changes are unknown.");
  }
  const start = JSON.parse(readFileSync(snapshot, "utf8"));
  const now = changedHashes(root, start.head);
  const changed = Object.keys(now)
    .filter((path) => now[path] !== start.files[path])
    .sort();
  const targets = lintTargets(changed);
  if (!targets.length) return 0;
  const cwd = join(root, INSPECTOR);
  const eslint = join(
    dirname(
      createRequire(join(cwd, "package.json")).resolve("eslint/package.json"),
    ),
    "bin/eslint.js",
  );
  const state = sessionFile("report", input.session_id, root);
  try {
    execFileSync(
      process.execPath,
      [
        eslint,
        "--pass-on-unpruned-suppressions",
        "--no-warn-ignored",
        ...targets,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
      },
    );
    rmSync(state, { force: true });
    return 0;
  } catch (error) {
    // ESLint exits 1 for lint errors and 2 for a bad config or a crash; a
    // timeout has no status. Only lint errors are the agent's to fix.
    if (error.status !== 1 || !error.stdout) {
      return skipped(error.stderr || error.message);
    }
    const last = existsSync(state) ? readFileSync(state, "utf8") : "";
    const tree = changed.map((path) => `${path}\0${now[path]}`).join("\0");
    const { repeat, seen } = repeatCheck(error.stdout, tree, last);
    if (repeat) return 0;
    writeFileSync(state, seen);
    process.stderr.write(
      `ESLint found errors in files this turn changed:\n${trimOutput(error.stdout)}\n`,
    );
    return 2;
  }
}

export function lintChanged(input) {
  try {
    return lint(input);
  } catch (error) {
    // A broken check must not wedge a session or hide the ratchet's report.
    return skipped(error.message);
  }
}

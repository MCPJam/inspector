/**
 * The Stop hook's UI evidence step: when the turn changed UI source and no
 * passing inspector driver report from this checkout is newer than that
 * change, remind the agent once to open the screen in the running app before
 * it says the change works.
 *
 * The candidates are the ratchet's: tracked changes since the merge-base with
 * origin/main, plus untracked files that appeared during the turn. With a
 * turn-start snapshot, only files touched since the turn began count, so the
 * lower branches of a stack do not. A deleted file counts from when its
 * folder last changed. The reminder fires once per change set, so an agent
 * that cannot start the app (no backend profile, say) can still end the turn
 * and say so.
 *
 * A report counts when the driver wrote it in its default folder for this
 * checkout and it has no ISSUE. That does not prove it covers the changed
 * screen; the reminder asks for that, and the reply has to show it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { repoRootFor, snapshotFile } from "./hook.mjs";

/** Source that renders in the inspector: the client and the UI packages it bundles. */
const UI_ROOTS = [
  "mcpjam-inspector/client/src",
  "design-system/src",
  "chat-ui/src",
];
/** Where `inspector-driver.mjs` writes each run's JSON reports without `--out`. */
const DRIVER_RUNS = join(homedir(), ".mcpjam", "driver", "runs");
const MAX_FILES = 5;
const DRIVER = "node mcpjam-inspector/scripts/inspector-driver.mjs";

/** UI source a person would see running; tests and test support are not. */
export function isUiSource(path) {
  return (
    UI_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
    !/(^|\/)(__tests__|__mocks__|test)\//.test(path) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

/** Paths compare equal across slash styles, and drive letter case on Windows. */
function samePath(a, b) {
  const norm = (p) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return typeof a === "string" && norm(a) === norm(b);
}

/**
 * Newest modification time among passing reports that `inspectorDir`'s
 * driver wrote in `runsDir`, 0 for none. Reports no newer than `sinceMs`
 * cannot satisfy the check and are not read.
 */
export function newestReport(runsDir, inspectorDir, sinceMs = 0) {
  let runs;
  try {
    runs = readdirSync(runsDir, { withFileTypes: true });
  } catch (error) {
    // No folder means the driver has never run. Any other failure rethrows,
    // and the hook passes rather than nag about evidence it cannot see.
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  let newest = 0;
  for (const run of runs.filter((entry) => entry.isDirectory())) {
    const dir = join(runsDir, run.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const { mtimeMs } = statSync(path);
      if (mtimeMs <= Math.max(newest, sinceMs)) continue;
      const report = JSON.parse(readFileSync(path, "utf8"));
      if (
        samePath(report.checkout, inspectorDir) &&
        report.classified?.issues?.length === 0
      ) {
        newest = mtimeMs;
      }
    }
  }
  return newest;
}

/**
 * The reminder for `changed` ({ path, mtimeMs } of each UI file), or null
 * when a report is newer than every change or this change set was already
 * reminded about. `key` identifies the change set for the next Stop.
 */
export function checkEvidence(changed, newestReportMs, lastKey) {
  if (!changed.length) return null;
  if (newestReportMs > Math.max(...changed.map((file) => file.mtimeMs))) {
    return null;
  }
  const key = createHash("sha256")
    .update(
      changed
        .map((file) => `${file.path}\0${file.mtimeMs}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  if (key === lastKey) return null;
  const paths = changed.map((file) => file.path).sort();
  const shown = paths.slice(0, MAX_FILES).map((path) => `  ${path}`);
  if (paths.length > MAX_FILES) {
    shown.push(`  and ${paths.length - MAX_FILES} more`);
  }
  const message = [
    "These UI files changed and no passing inspector driver run from this checkout has happened since:",
    ...shown,
    "Open the affected screen in the running app (run-inspector skill):",
    `  ${DRIVER} start`,
    `  ${DRIVER} open <surface>`,
    `\`${DRIVER} surfaces\` lists the surface ids. If the app cannot start here, say so in your reply; this reminder does not repeat for these changes.`,
  ].join("\n");
  return { key, message };
}

/** Where this session's last reminded change set lives. */
function stateFile(sessionId, root) {
  const key = createHash("sha256")
    .update(`${sessionId ?? ""}\0${root}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `slop-hook-driver-${key}.txt`);
}

/** When `path` last changed; for a deleted file, when its nearest folder did. */
function changedAt(root, path) {
  let at = join(root, path);
  while (!existsSync(at)) at = dirname(at);
  return statSync(at).mtimeMs;
}

function changedFiles(root, snapshot) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  const base = git("merge-base", "HEAD", "origin/main").trim();
  const tracked = git(
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    "--",
    ...UI_ROOTS,
  ).split("\0");
  // Without a turn-start snapshot, tracked files only, as the ratchet does.
  if (!existsSync(snapshot)) return tracked;
  const before = new Set(readFileSync(snapshot, "utf8").split("\n"));
  const untracked = git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...UI_ROOTS,
  )
    .split("\0")
    .filter((path) => !before.has(path));
  return [...tracked, ...untracked];
}

function remind(input) {
  const root = repoRootFor(input.cwd ?? process.cwd());
  if (!root) return 0;
  const snapshot = snapshotFile(input.session_id, root);
  const turnStartMs = existsSync(snapshot) ? statSync(snapshot).mtimeMs : 0;
  const changed = [...new Set(changedFiles(root, snapshot))]
    .filter(isUiSource)
    .map((path) => ({ path, mtimeMs: changedAt(root, path) }))
    .filter((file) => file.mtimeMs >= turnStartMs);
  if (!changed.length) return 0;
  const state = stateFile(input.session_id, root);
  const last = existsSync(state) ? readFileSync(state, "utf8") : "";
  const newest = newestReport(
    DRIVER_RUNS,
    join(root, "mcpjam-inspector"),
    Math.max(...changed.map((file) => file.mtimeMs)),
  );
  const result = checkEvidence(changed, newest, last);
  if (!result) return 0;
  writeFileSync(state, result.key);
  process.stderr.write(`${result.message}\n`);
  return 2;
}

export function driverRunReminder(input) {
  try {
    return remind(input);
  } catch {
    // A broken check must not wedge a session or hide the ratchet's report.
    return 0;
  }
}

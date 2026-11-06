/**
 * Publish the triage: commit all autofixes to the PR branch as one commit,
 * push it, then fold the run into the pipeline's one summary comment. Nothing
 * else is posted: items for a person go in that comment, not inline.
 *
 * Edits go through git plumbing (blob, index, commit), never the working tree,
 * so a path the PR made a symlink cannot redirect a write.
 *
 * Env: GITHUB_TOKEN (the bot's app token), GITHUB_REPOSITORY, APP_SLUG,
 * STATE_DIR, REPO_DIR. Reads `gate.json` and `triage.json`; writes the
 * `pushed` step output.
 */
import { appendFileSync } from "node:fs";
import {
  AUTOFIX_TRAILER, PHASES, githubClient, gitIn, isEntrypoint, readBlob, readState, requireEnv, runEntrypoint,
} from "./review-common.mjs";
import { recordPhase, updateSummary } from "./review-summary.mjs";
import { applyEdit } from "./review-triage.mjs";

/**
 * Stage every autofix and commit them together on top of HEAD, so a run pushes
 * one commit. Edits to the same file build on each other; one that no longer
 * applies after an earlier edit becomes a suggestion.
 */
export function commitAutofixes(items, { runGit, phase, identity }) {
  const staged = new Map();
  const result = items.map((item) => {
    if (item.category !== "autofix") return item;
    const blob = staged.get(item.path) ?? readBlob(runGit, "HEAD", item.path);
    const next = blob && applyEdit(blob.content, item.find, item.replace);
    if (next === null || next === undefined) {
      return { ...item, category: "suggest", downgraded: "an earlier fix changed these lines" };
    }
    staged.set(item.path, { ...blob, content: next });
    return { ...item, applied: true };
  });
  const applied = result.filter((item) => item.applied);
  if (applied.length === 0) return result;
  for (const [path, { mode, content }] of staged) {
    const hash = runGit(["hash-object", "-w", "--stdin"], content).trim();
    runGit(["update-index", "--cacheinfo", `${mode},${hash},${path}`]);
  }
  const subject = applied.length === 1 ? applied[0].commit : `Apply ${applied.length} review autofixes`;
  const details = applied.length === 1 ? "" : `${applied.map((item) => `- ${item.commit}`).join("\n")}\n\n`;
  runGit(["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-q", "--no-verify",
    "-m", `${subject}\n\n${details}${AUTOFIX_TRAILER}: ${phase}`]);
  const sha = runGit(["rev-parse", "HEAD"]).trim();
  return result.map(({ applied: done, ...item }) => (done ? { ...item, sha } : item));
}

/** The status line for a run: still working when it pushed, otherwise ready to hand over. */
export function runStatus({ gate, autofixed, open }) {
  const phase = PHASES.find((entry) => entry.id === gate.phase).name;
  if (autofixed.length) {
    return `**Working.** Pushed ${autofixed.length} fix${autofixed.length === 1 ? "" : "es"} for ${phase} in ` +
      `\`${autofixed[0].sha.slice(0, 7)}\`; the checks run again on it.`;
  }
  const left = open ? ` ${open} item${open === 1 ? "" : "s"} below need${open === 1 ? "s" : ""} a person.` : "";
  return `**Done with \`${gate.sha.slice(0, 7)}\`.** The bot has nothing more it can fix.${left}`;
}

export async function publish({ gate, triage, request, runGit, push, identity, commitUrl }) {
  const current = await request(`pulls/${gate.pr}`);
  if (current.state !== "open" || current.head.sha !== gate.sha) {
    return { skipped: "The PR changed during the run; the new head gets its own run." };
  }
  const items = commitAutofixes(triage.items, { runGit, phase: gate.phase, identity });
  const autofixed = items.filter((item) => item.sha);
  if (autofixed.length) push(gate.headRef);
  const state = await updateSummary(request, gate.pr, identity.name, (previous) => {
    const next = recordPhase(previous, { gate, triage: { ...triage, items }, autofixed, commitUrl });
    const open = Object.values(next.open).flat().length;
    return { ...next, status: runStatus({ gate, autofixed, open }) };
  });
  return { pushed: autofixed.length > 0, autofixed: autofixed.length, open: Object.values(state.open).flat().length };
}

async function botIdentity(slug) {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not look up ${slug}[bot]: HTTP ${response.status}`);
  const { id } = await response.json();
  return { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` };
}

export async function main() {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "APP_SLUG", "STATE_DIR", "REPO_DIR"]);
  const gate = readState("gate");
  const triage = readState("triage");
  const runGit = gitIn(process.env.REPO_DIR);
  const auth = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
  const push = (ref) => runGit(["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
    "push", "-q", "origin", `HEAD:refs/heads/${ref}`]);
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const result = await publish({
    gate, triage, runGit, push, request: githubClient(),
    identity: await botIdentity(process.env.APP_SLUG),
    commitUrl: (sha) => `${server}/${process.env.GITHUB_REPOSITORY}/pull/${gate.pr}/commits/${sha}`,
  });
  if (result.skipped) {
    console.log(`::notice::${result.skipped}`);
    return;
  }
  console.log(`Summary updated: ${result.autofixed} autofixes pushed, ${result.open} items for a person.`);
  // Only a run that pushed nothing may hand the PR over: a push restarts CI.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pushed=${result.pushed}\n`);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);

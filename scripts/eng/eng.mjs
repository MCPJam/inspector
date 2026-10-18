#!/usr/bin/env node
/**
 * The agent's handle on eng flow state. Engineers never need to run it; the
 * eng skill tells the agent when to.
 *
 *   map <PP-123> [task-url]   tie this branch to a Kestral task
 *   step <name>               record the flow step (task, specs, plan, review2, build, review)
 *   decline                   the engineer said no: stop offering on this branch
 *   uploaded <session-id>     a session record is now on the task
 *   status                    print this branch's entry and pending records
 *   repos                     where the other MCPJam repo is, and how stale
 *   trailer <commit-msg-file> add `Kestral: <task>` (run by prepare-commit-msg)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describeOtherRepo, findOtherRepo } from "./repos.mjs";
import { STEPS, checkoutOf, entryFor, readState, updateState } from "./state.mjs";

const TASK = /^[A-Z][A-Z0-9]*-\d+$/;

export function addTrailer(file, task) {
  if (/^Kestral:/m.test(readFileSync(file, "utf8"))) return false;
  execFileSync("git", ["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `Kestral: ${task}`, file]);
  return true;
}

export function run(args, cwd = process.cwd()) {
  const [command, ...rest] = args;
  const checkout = checkoutOf(cwd);
  if (!checkout) throw new Error("Not in a git checkout.");
  const now = new Date().toISOString();
  const branch = checkout.branch;

  if (command === "map") {
    const [task, url] = rest;
    if (!TASK.test(task ?? "")) throw new Error("Usage: map <PP-123> [task-url]");
    updateState(checkout.engDir, (s) => {
      s.branches[branch] = { ...s.branches[branch], task, url, step: s.branches[branch]?.step ?? "specs", mappedAt: now };
    });
    return `${branch} -> ${task}`;
  }
  if (command === "step") {
    if (!STEPS.includes(rest[0])) throw new Error(`Step is one of: ${STEPS.join(", ")}`);
    const entry = entryFor(readState(checkout.engDir), checkout);
    if (!entry?.task) throw new Error("Map the branch to a task first.");
    updateState(checkout.engDir, (s) => {
      s.branches[branch] = { ...entry, inherited: undefined, branch: undefined, step: rest[0], stepAt: now };
    });
    return `${branch}: step ${rest[0]}`;
  }
  if (command === "decline") {
    updateState(checkout.engDir, (s) => {
      s.branches[branch] = { ...s.branches[branch], declined: now };
    });
    return `No more offers on ${branch}.`;
  }
  if (command === "uploaded") {
    updateState(checkout.engDir, (s) => {
      if (!s.sessions[rest[0]]) throw new Error(`No session record ${rest[0]}.`);
      s.sessions[rest[0]].uploadedAt = now;
    });
    return `Session ${rest[0]} marked uploaded.`;
  }
  if (command === "status") {
    const state = readState(checkout.engDir);
    const entry = entryFor(state, checkout);
    const records = Object.entries(state.sessions).filter(([, s]) => entry?.task && s.task === entry.task);
    return JSON.stringify({ branch, entry, records: Object.fromEntries(records) }, null, 2);
  }
  if (command === "repos") {
    return describeOtherRepo(findOtherRepo(checkout.root)) ?? "This is not an MCPJam repository.";
  }
  if (command === "trailer") {
    const entry = entryFor(readState(checkout.engDir), checkout);
    if (entry?.task && rest[0]) addTrailer(rest[0], entry.task);
    return "";
  }
  throw new Error(`Unknown command ${command ?? "(none)"}. See the header of scripts/eng/eng.mjs.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const out = run(process.argv.slice(2));
    if (out) console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Micro-test: what does terminateOwnedProcessGroup report when the ROOT exits
// on its own (a) leaving nothing behind, (b) leaving a child in its group?
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProcessBirthIdentity, terminateOwnedProcessGroup, probeProcessGroup } from "../process-identity.js";
const execFileP = promisify(execFile);
// Any Node will do: this measures PROCESS GROUP settlement, not the pack. The
// running interpreter is the default so the script works with no arguments —
// which is how CI invokes it, and how it used to crash before reaching a test.
const NODE = process.argv[2] ?? process.execPath;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function groupPs(pgid: number) { try { return (await execFileP("ps", ["-o", "pid=,pgid=,stat=,command=", "-ax"])).stdout.split("\n").filter((l) => l.split(/\s+/).filter(Boolean)[1] === String(pgid)).map((l) => l.trim().slice(0, 90)); } catch { return []; } }
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[group-settle] FAILED: ${message}`);
    process.exitCode = 1;
  }
}

async function run(
  label: string,
  script: string,
  expected: { outcome: string; groupAfter: "empty" | "populated" },
) {
  const child = spawn(NODE, ["-e", script], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  const identity = (await readProcessBirthIdentity(pid))!;
  await sleep(1500); // let the leader exit on its own
  console.log(`\n[${label}] leader ${pid} exited on its own; group now:`, await groupPs(pid));
  console.log(`[${label}] probeProcessGroup:`, await probeProcessGroup(pid));
  const outcome = await terminateOwnedProcessGroup({ pid, birthIdentity: identity, graceMs: 1000 });
  console.log(`[${label}] terminateOwnedProcessGroup:`, JSON.stringify(outcome));
  const after = await groupPs(pid);
  console.log(`[${label}] group after:`, after);
  // Asserted, not merely printed. This scenario documents WHY the supervisor
  // takes a member snapshot at the root's exit; a run that silently reported
  // the opposite outcomes would be documenting the reverse.
  assert(
    outcome.outcome === expected.outcome,
    `[${label}] expected outcome ${expected.outcome}, got ${JSON.stringify(outcome)}`,
  );
  assert(
    (after.length === 0) === (expected.groupAfter === "empty"),
    `[${label}] expected the group to be ${expected.groupAfter} afterwards, saw ${JSON.stringify(after)}`,
  );
  for (const l of after) { const p = Number(l.split(/\s+/)[0]); try { process.kill(p, "SIGKILL"); } catch {} }
}

// A leader that exits cleanly leaves nothing: the group is already empty, so
// there is nothing to signal and nothing to prove.
await run("a-clean-exit", "setTimeout(()=>{}, 300)", {
  outcome: "already-gone",
  groupAfter: "empty",
});
// A leader that leaves a child behind is the case the snapshot exists for:
// the group is live, but with the root already gone nothing ties it to this
// tree, so it is REPORTED rather than signalled.
await run(
  "b-child-left-behind",
  "require('child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'}).unref(); setTimeout(()=>process.exit(0), 300)",
  { outcome: "unknown", groupAfter: "populated" },
);

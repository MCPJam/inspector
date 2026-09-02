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
async function run(label: string, script: string) {
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
  for (const l of after) { const p = Number(l.split(/\s+/)[0]); try { process.kill(p, "SIGKILL"); } catch {} }
}
await run("a-clean-exit", "setTimeout(()=>{}, 300)");
await run("b-child-left-behind", "require('child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'}).unref(); setTimeout(()=>process.exit(0), 300)");

// Spawn counter for the stdio auto-negotiation activation test.
//
// A stdio "server" that never speaks MCP: it records each SPAWN of the binary
// to $SPAWN_LOG (one line per process), then stays alive consuming stdin. The
// connection therefore never completes — the only observable is how many times
// the server binary was spawned.
//
// This isolates the Phase 5 activation-checklist "double-spawn (sibling
// process)" concern: with auto negotiation on stdio the beta.4 client MAY
// spawn the binary an extra time for its `server/discover` probe. Counting
// spawns (rather than asserting a completed connection) is the honest, non
// -flaky way to bound that side-effect. See the accompanying test for the
// measured bounds and what the probe is / is not allowed to be labeled as.
import { appendFileSync } from "node:fs";
const logPath = process.env.SPAWN_LOG;
if (logPath) appendFileSync(logPath, `spawn ${process.pid} ${Date.now()}\n`);
process.stdin.resume();
process.stdin.on("data", () => {});
setInterval(() => {}, 1 << 30);

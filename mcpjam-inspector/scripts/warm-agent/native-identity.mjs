// Linux /proc start time distinguishes a living agent from a recycled PID.
// Read names and process ancestry only. Command lines can contain credentials.
import { readFileSync, readdirSync } from "node:fs";
import { processBirthIdentity } from "../../server/utils/harness/warm-bridge.ts";

export function nativeIdentity(parentPid, client, proc = "/proc") {
  const expected = client === "claude-code" ? "claude" : "codex";
  const tree = new Map();
  for (const dir of readdirSync(proc)) {
    if (!/^\d+$/.test(dir)) continue;
    let stat;
    try {
      stat = readFileSync(proc + "/" + dir + "/stat", "utf8");
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) continue;
      throw error;
    }
    const end = stat.lastIndexOf(")");
    const [state, parent] = stat.slice(end + 2).split(" ");
    const name = stat.slice(stat.indexOf("(") + 1, end);
    tree.set(Number(dir), {
      parent: Number(parent),
      name,
      state,
      birth: processBirthIdentity(stat),
    });
  }
  const matches = [];
  for (const [pid, row] of tree) {
    if (row.name !== expected || row.state === "Z" || !row.birth) continue;
    const seen = new Set([pid]);
    let next = row.parent;
    while (tree.has(next) && !seen.has(next) && next !== parentPid) {
      seen.add(next);
      next = tree.get(next).parent;
    }
    if (next === parentPid) matches.push({ pid, birth: row.birth });
  }
  return matches.length === 1 ? matches[0] : null;
}

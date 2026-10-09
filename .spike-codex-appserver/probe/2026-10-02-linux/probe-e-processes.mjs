// Probe (e): do processes the agent backgrounds survive the app-server being killed?
//
// The app-server (node codex.js app-server -> native codex) is spawned DETACHED, i.e. as the leader
// of its own process group, the way a supervisor would. The fake model runs, one exec_command each:
//   plain    `sleep N1 &`                                  (stdout still attached)
//   plainnull`sleep N2 >/dev/null 2>&1 &`
//   setsid   `setsid sleep N3 >/dev/null 2>&1 &`
//   nohup    `nohup sleep N4 >/dev/null 2>&1 &`
//   dblfork  `(sleep N5 >/dev/null 2>&1 &)`
// After turn/completed we snapshot `ps -eo pid,ppid,pgid,sid,stat,cmd`, then kill the group:
//   term-kill: SIGTERM to -pgid, wait 3 s, SIGKILL to -pgid      (supervisor)
//   kill:      SIGKILL to -pgid immediately                      (crash / hard stop)
// and snapshot again 2 s later. Every `sleep 3xyz` is then killed (cleanup is verified).
//
// Cases: danger-termkill, danger-kill, ws-termkill, ws-kill   (danger = sandbox danger-full-access,
//        ws = sandbox workspace-write via bwrap). Approval policy "never" throughout.
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, items, writeJson, HERE } from "./lib.mjs";

const ps = () =>
  execFileSync("ps", ["-eo", "pid,ppid,pgid,sid,stat,cmd", "--no-headers"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], pgid: +m[3], sid: +m[4], stat: m[5], cmd: m[6] };
    })
    .filter(Boolean);
const sleeps = (base) => ps().filter((p) => new RegExp(`^sleep ${String(base).slice(0, 2)}\\d\\d$`).test(p.cmd));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function runCase(name, { sandbox, killStyle, base }) {
  const d = freshDirs(`e-${name}`);
  const v = { plain: base + 1, plainnull: base + 2, setsid: base + 3, nohup: base + 4, dblfork: base + 5 };
  const cmds = [
    ["plain", `sleep ${v.plain} &`],
    ["plainnull", `sleep ${v.plainnull} >/dev/null 2>&1 &`],
    ["setsid", `setsid sleep ${v.setsid} >/dev/null 2>&1 &`],
    ["nohup", `nohup sleep ${v.nohup} >/dev/null 2>&1 &`],
    ["dblfork", `(sleep ${v.dblfork} >/dev/null 2>&1 &)`],
  ];
  const fake = createFake({
    script: [
      ...cmds.map(([id, cmd]) => ({ functionCalls: [{ name: "exec_command", callId: `call_${id}`, arguments: { cmd, yield_time_ms: 2000 } }] })),
      // mid-turn snapshot, from inside the agent's own shell (sandboxed in ws mode, so a PID namespace may hide them)
      { functionCalls: [{ name: "exec_command", callId: "call_midturn_ps", arguments: { cmd: `ps -eo pid,ppid,pgid,sid,cmd | grep "[s]leep ${String(base).slice(0, 2)}"; echo PS_DONE` } }] },
      { text: "started them" },
    ],
    logPath: join(d.root, "http.ndjson"),
  });
  const origin = await fake.listen();
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1` }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: d.cwd, home: d.home, env: { TMPDIR: d.tmp }, logPath: join(d.root, "rpc.ndjson"), detached: true });
  const appPid = app.child.pid;
  const r = { case: name, sandbox, killStyle, sleepDurations: v, appServer: { wrapperPid: appPid } };
  try {
    await app.init();
    const t = await app.startThreadAndTurn({ threadParams: { cwd: d.cwd, approvalPolicy: "never", sandbox }, prompt: "Start background jobs.", timeoutMs: 90_000 });
    r.turnStatus = t.completed.status;
    r.commands = items(app.notifications, "commandExecution").map((i) => ({ id: i.id, status: i.status, exitCode: i.exitCode, processId: i.processId ?? null }));
    r.midTurnPsFromAgentShell = (items(app.notifications, "commandExecution").find((i) => i.id === "call_midturn_ps")?.aggregatedOutput ?? "").trim().split("\n");
    await sleep(1000);
    const before = ps();
    const appProc = before.find((p) => p.pid === appPid);
    r.appServer.pgid = appProc?.pgid;
    r.appServer.sid = appProc?.sid;
    r.appServer.tree = before.filter((p) => p.pgid === appProc?.pgid || p.ppid === appPid).map((p) => `${p.pid} ppid=${p.ppid} pgid=${p.pgid} sid=${p.sid} ${p.cmd.slice(0, 90)}`);
    r.beforeKill = sleeps(base).map((p) => ({ ...p, inAppServerPgid: p.pgid === appProc?.pgid, inAppServerSid: p.sid === appProc?.sid }));
    // ---- the supervisor kill
    const pgid = appProc?.pgid ?? appPid;
    if (killStyle === "term-kill") {
      process.kill(-pgid, "SIGTERM");
      await sleep(3000);
      try {
        process.kill(-pgid, "SIGKILL");
        r.sigkillSent = true;
      } catch (e) {
        r.sigkillSent = `not needed (${e.code})`;
      }
    } else {
      process.kill(-pgid, "SIGKILL");
    }
    const exit = await Promise.race([app.exited, sleep(8000).then(() => "still running")]);
    r.appServerExit = exit;
    await sleep(2000);
    r.appServerGroupLeft = ps().filter((p) => p.pgid === pgid).map((p) => `${p.pid} ${p.cmd.slice(0, 80)}`);
    r.afterKill = sleeps(base).map((p) => ({ ...p, variant: Object.entries(v).find(([, n]) => p.cmd === `sleep ${n}`)?.[0] }));
    r.survivors = Object.fromEntries(Object.entries(v).map(([k, n]) => [k, r.afterKill.some((p) => p.cmd === `sleep ${n}`)]));
  } catch (e) {
    r.error = e.message;
  } finally {
    try {
      process.kill(-appPid, "SIGKILL");
    } catch {}
    await fake.close();
    // cleanup every sleep this case started
    for (const p of sleeps(base)) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {}
    }
    await sleep(500);
    r.cleanupRemaining = sleeps(base).length;
  }
  writeJson(join(HERE, "results", `e-${name}.json`), r);
  console.log(`\n===== ${name}\n${JSON.stringify(r, null, 1)}`);
  return r;
}

const cases = {
  "danger-termkill": () => runCase("danger-termkill", { sandbox: "danger-full-access", killStyle: "term-kill", base: 3100 }),
  "danger-kill": () => runCase("danger-kill", { sandbox: "danger-full-access", killStyle: "kill", base: 3200 }),
  "ws-termkill": () => runCase("ws-termkill", { sandbox: "workspace-write", killStyle: "term-kill", base: 3300 }),
  "ws-kill": () => runCase("ws-kill", { sandbox: "workspace-write", killStyle: "kill", base: 3400 }),
};
const want = process.argv.slice(2);
for (const [n, fn] of Object.entries(cases)) if (!want.length || want.includes(n)) await fn();

// Probe (c): Linux sandbox behaviour of codex app-server 0.149.1.
//
// Cases (select with argv; default = all):
//   control        thread sandbox danger-full-access, approval never  (do the probes work at all?)
//   ws             approval never + turn/start sandboxPolicy workspaceWrite
//                  {writableRoots:[], networkAccess:false, excludeSlashTmp:true, excludeTmpdirEnvVar:false}
//                  incl. an exec_command with sandbox_permissions:"require_escalated"
//   ws-symlink     same, thread/turn cwd is a SYMLINK to the real dir
//   fail-pathbwrap same as ws, but a failing `bwrap` is first on PATH (attempted init-failure simulation;
//                  codex warned and still sandboxed -> not a failure simulation after all)
//   fail-userns    same as ws, codex run inside a nested user namespace whose max_user_namespaces = 0
//                  (the host sysctl is read-only even to root here), i.e. bwrap cannot create a userns
//   fail-userns-attended  same lockdown under approvalPolicy on-request + workspace-write
//   attended       thread approvalPolicy untrusted + sandbox workspace-write (model gpt-5.5, which declares
//                  apply_patch): which actions raise a server request?
//   attended-login-false  are read-only commands auto-approved under untrusted with login:false?
//
// Per command the model "runs", we record the commandExecution item (status/exit/output) and, after the
// turn, whether each target file exists on the host. Files under /tmp/codex-probe-* are removed afterwards.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, items, callOutputs, writeJson, HERE } from "./lib.mjs";

const WS_POLICY = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: false };

function sandboxCommands(tag, port) {
  const R = (name) => `&& echo "RESULT ${name} OK" || echo "RESULT ${name} FAIL"`;
  return [
    { id: "cwd_write", cmd: `echo hi > cwd-write.txt ${R("cwd_write")}; pwd -P` },
    { id: "tmpdir_write", cmd: `echo hi > "$TMPDIR/tmpdir-write.txt" ${R("tmpdir_write")}; echo "TMPDIR=$TMPDIR"` },
    { id: "slashtmp_write", cmd: `echo hi > /tmp/codex-probe-elsewhere-${tag}.txt ${R("slashtmp_write")}` },
    { id: "home_write", cmd: `echo hi > "$HOME/home-write.txt" ${R("home_write")}; echo "HOME=$HOME"` },
    { id: "etc_read", cmd: `cat /etc/hostname ${R("etc_read")}` },
    { id: "curl_ext", cmd: `out=$(curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com 2>&1); echo "RESULT curl_ext rc=$? $out"` },
    { id: "curl_direct", cmd: `out=$(curl --noproxy '*' -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com 2>&1); echo "RESULT curl_direct rc=$? $out"` },
    {
      id: "node_fetch",
      cmd: `NODE_USE_ENV_PROXY=1 ${process.execPath} -e "fetch('https://example.com').then(r=>console.log('RESULT node_fetch OK status',r.status)).catch(e=>console.log('RESULT node_fetch FAIL',e.cause?.code||e.cause?.message||e.message))"`,
    },
    { id: "loopback", cmd: `out=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/v1/models 2>&1); echo "RESULT loopback rc=$? $out"` },
    {
      id: "env",
      cmd: `echo "RESULT env HTTPS_PROXY=\${HTTPS_PROXY:-unset} CODEX_SANDBOX=\${CODEX_SANDBOX:-unset} CODEX_SANDBOX_NETWORK_DISABLED=\${CODEX_SANDBOX_NETWORK_DISABLED:-unset}"; grep -E "NoNewPrivs|Seccomp:" /proc/self/status; echo "pid1=$(cat /proc/1/comm)"; id -u`,
    },
  ];
}

async function runCase(name, { threadParams = {}, turnParams = {}, commands, env = {}, symlink = false, model, onServerRequest, extraSteps = [], wrapper = [] }) {
  const d = freshDirs(`c-${name}`);
  let cwd = d.cwd;
  if (symlink) {
    cwd = join(d.root, "cwd-link");
    symlinkSync(d.cwd, cwd);
  }
  let steps = [];
  const fake = createFake({
    script: ({ index }) => steps[index] ?? { text: "done" },
    logPath: join(d.root, "http.ndjson"),
  });
  const origin = await fake.listen();
  const port = new URL(origin).port;
  const tag = `${name}-${process.pid}`;
  const cmds = commands(tag, port);
  steps = [
    ...cmds.map((c, i) => ({
      functionCalls: [{ name: "exec_command", callId: `call_${c.id}`, arguments: { cmd: c.cmd, yield_time_ms: 15000, ...(c.extraArgs ?? {}) } }],
    })),
    ...extraSteps,
    { text: "done" },
  ];
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1` }));
  const app = startAppServer({ codexHome: d.codexHome, cwd, home: d.home, env: { TMPDIR: d.tmp, ...env }, logPath: join(d.root, "rpc.ndjson"), wrapper });
  const requestsSeen = [];
  app.onServerRequest(async (frame) => {
    requestsSeen.push({ method: frame.method, itemId: frame.params?.itemId, command: frame.params?.command, reason: frame.params?.reason, grantRoot: frame.params?.grantRoot, availableDecisions: frame.params?.availableDecisions, keys: Object.keys(frame.params ?? {}) });
    return onServerRequest ? onServerRequest(frame) : { decision: "decline" };
  });
  const r = { case: name, cwd, realCwd: d.cwd, tmpdir: d.tmp, home: d.home };
  try {
    await app.init();
    const t = await app.startThreadAndTurn({
      threadParams: { cwd, ...(model ? { model } : {}), ...threadParams },
      turnParams: { ...(turnParams.cwd === "__cwd__" ? { ...turnParams, cwd } : turnParams) },
      prompt: "Run the probe commands.",
      timeoutMs: 180_000,
    });
    r.thread = { approvalPolicy: t.thread.approvalPolicy, sandbox: t.thread.sandbox, cwd: t.thread.cwd };
    r.turnStatus = t.completed.status;
    r.turnError = t.completed.error ?? null;
  } catch (e) {
    r.error = e.message.slice(0, 600);
  } finally {
    await app.close();
    await fake.close();
  }
  const outputs = callOutputs(fake.requests);
  const cmdItems = Object.fromEntries(items(app.notifications, "commandExecution").map((i) => [i.id, i]));
  r.commands = cmds.map((c) => {
    const it = cmdItems[`call_${c.id}`];
    const fo = outputs[`call_${c.id}`];
    return {
      id: c.id,
      itemStatus: it?.status ?? null,
      exitCode: it?.exitCode ?? null,
      output: (it?.aggregatedOutput ?? (typeof fo === "string" ? fo : JSON.stringify(fo ?? null))).trim().slice(0, 600),
    };
  });
  r.fileChanges = items(app.notifications, "fileChange").map((i) => ({ id: i.id, status: i.status, changes: (i.changes ?? []).map((c) => `${c.kind?.type ?? "?"} ${c.path}`) }));
  r.otherItems = items(app.notifications).filter((i) => !["commandExecution", "fileChange", "userMessage", "agentMessage", "reasoning"].includes(i.type)).map((i) => ({ type: i.type, id: i.id, status: i.status }));
  r.serverRequests = requestsSeen;
  r.callOutputsNonCommand = Object.fromEntries(Object.entries(outputs).filter(([k]) => !cmds.some((c) => `call_${c.id}` === k)).map(([k, v]) => [k, String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 400)]));
  r.hostFiles = {
    cwd_write: existsSync(join(d.cwd, "cwd-write.txt")),
    tmpdir_write: existsSync(join(d.tmp, "tmpdir-write.txt")),
    slashtmp_write: existsSync(`/tmp/codex-probe-elsewhere-${tag}.txt`),
    home_write: existsSync(join(d.home, "home-write.txt")),
    escalated_write: existsSync(`/tmp/codex-probe-escalated-${tag}.txt`),
    attended_write: existsSync(join(d.cwd, "attended.txt")),
    patched_custom: existsSync(join(d.cwd, "patched-custom.txt")),
    patched_heredoc: existsSync(join(d.cwd, "patched-heredoc.txt")),
  };
  r.warnings = app.notifications.filter((n) => ["warning", "configWarning", "error"].includes(n.method)).map((n) => `${n.method}: ${JSON.stringify(n.params).slice(0, 400)}`);
  r.stderrTail = app.stderr.join("").split("\n").filter(Boolean).slice(-15);
  for (const f of readdirSync("/tmp")) if (f.startsWith("codex-probe-")) rmSync(join("/tmp", f), { force: true });
  writeJson(join(HERE, "results", `c-${name}.json`), r);
  console.log(`\n===== ${name}`);
  console.log(JSON.stringify({ thread: r.thread, turnStatus: r.turnStatus, error: r.error, hostFiles: r.hostFiles, serverRequests: r.serverRequests, fileChanges: r.fileChanges }, null, 1));
  for (const c of r.commands) console.log(`  [${c.id}] status=${c.itemStatus} exit=${c.exitCode} :: ${c.output.replace(/\n/g, " | ").slice(0, 260)}`);
  if (Object.keys(r.callOutputsNonCommand).length) console.log("  other call outputs:", r.callOutputsNonCommand);
  if (r.warnings.length) console.log("  warnings:", r.warnings.filter((w) => !/Model metadata/.test(w)));
  return r;
}

const withEscalation = (tag, port) => [
  ...sandboxCommands(tag, port),
  {
    id: "escalated_write",
    cmd: `echo hi > /tmp/codex-probe-escalated-${tag}.txt && echo "RESULT escalated_write OK" || echo "RESULT escalated_write FAIL"`,
    extraArgs: { sandbox_permissions: "require_escalated", justification: "probe: needs to write outside the workspace" },
  },
];

const failingBwrapDir = () => {
  const dir = join(HERE, "runs", "fake-bwrap-bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "bwrap");
  writeFileSync(p, `#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n`);
  chmodSync(p, 0o755);
  return dir;
};

const PATCH = (file) => `*** Begin Patch\n*** Add File: ${file}\n+patched\n*** End Patch\n`;

const cases = {
  control: () => runCase("control", { threadParams: { approvalPolicy: "never", sandbox: "danger-full-access" }, commands: sandboxCommands }),
  ws: () => runCase("ws", { threadParams: { approvalPolicy: "never" }, turnParams: { approvalPolicy: "never", sandboxPolicy: WS_POLICY }, commands: withEscalation }),
  "ws-symlink": () =>
    runCase("ws-symlink", { symlink: true, threadParams: { approvalPolicy: "never" }, turnParams: { approvalPolicy: "never", sandboxPolicy: WS_POLICY, cwd: "__cwd__" }, commands: sandboxCommands }),
  "fail-pathbwrap": () =>
    runCase("fail-pathbwrap", {
      env: { PATH: `${failingBwrapDir()}:${process.env.PATH}` },
      threadParams: { approvalPolicy: "never" },
      turnParams: { approvalPolicy: "never", sandboxPolicy: WS_POLICY },
      commands: (tag, port) => sandboxCommands(tag, port).filter((c) => ["cwd_write", "slashtmp_write", "home_write", "curl_ext", "curl_direct", "env"].includes(c.id)),
    }),
  // /proc/sys/user/max_user_namespaces is read-only to this container's root, so user namespaces
  // are disabled the way a locked-down host would: codex runs inside a nested user namespace whose
  // max_user_namespaces is 0 (verified: `unshare -U true` there fails with ENOSPC).
  "fail-userns": () =>
    runCase("fail-userns", {
      wrapper: ["unshare", "-Urmpf", "--kill-child", "--mount-proc", "/bin/sh", "-c", 'echo 0 > /proc/sys/user/max_user_namespaces && exec "$@"', "sh"],
      threadParams: { approvalPolicy: "never" },
      turnParams: { approvalPolicy: "never", sandboxPolicy: WS_POLICY },
      commands: (tag, port) => [
        { id: "userns_check", cmd: 'cat /proc/sys/user/max_user_namespaces; unshare -U true && echo "RESULT userns_check AVAILABLE" || echo "RESULT userns_check BLOCKED"' },
        ...sandboxCommands(tag, port).filter((c) => ["cwd_write", "slashtmp_write", "home_write", "curl_ext", "curl_direct", "env"].includes(c.id)),
      ],
    }),
  // Same lockdown, attended policy: does a sandbox failure turn into an approval / escalation?
  "fail-userns-attended": () =>
    runCase("fail-userns-attended", {
      wrapper: ["unshare", "-Urmpf", "--kill-child", "--mount-proc", "/bin/sh", "-c", 'echo 0 > /proc/sys/user/max_user_namespaces && exec "$@"', "sh"],
      threadParams: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" },
      commands: (tag, port) => sandboxCommands(tag, port).filter((c) => ["cwd_write", "slashtmp_write"].includes(c.id)),
      onServerRequest: async () => ({ decision: "decline" }),
    }),
  // Follow-up: are "known-safe" read-only commands auto-approved under untrusted when NOT wrapped in a login shell?
  "attended-login-false": () =>
    runCase("attended-login-false", {
      model: "gpt-5.5",
      threadParams: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" },
      commands: () => [
        { id: "ro_ls_nologin", cmd: "ls -la", extraArgs: { login: false } },
        { id: "ro_cat_nologin", cmd: "cat /etc/hostname", extraArgs: { login: false } },
        { id: "ro_pwd_nologin", cmd: "pwd", extraArgs: { login: false } },
        { id: "write_nologin", cmd: "echo hi > attended.txt", extraArgs: { login: false } },
      ],
      onServerRequest: async () => ({ decision: "accept" }),
    }),
  attended: () =>
    runCase("attended", {
      model: "gpt-5.5",
      threadParams: { approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write" },
      commands: () => [
        { id: "attended_write", cmd: "echo hi > attended.txt" },
        { id: "attended_read", cmd: "cat /etc/hostname" },
        { id: "attended_ls", cmd: "ls -la" },
        { id: "attended_heredoc_patch", cmd: `apply_patch <<'EOF'\n${PATCH("patched-heredoc.txt")}EOF` },
      ],
      extraSteps: [{ customToolCalls: [{ name: "apply_patch", callId: "call_custom_patch", input: PATCH("patched-custom.txt") }] }],
      onServerRequest: async () => ({ decision: "accept" }),
    }),
};

const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(cases)) {
  if (want.length && !want.includes(name)) continue;
  await fn();
}

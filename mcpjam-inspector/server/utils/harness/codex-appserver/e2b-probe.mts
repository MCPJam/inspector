/**
 * HOSTED CODEX ON E2B, scripted model: the real app-server adapter, the real
 * bootstrap and bridge, a real `mcpjam-computer` box. Only the model is fake
 * (the conformance mock, run INSIDE the box so Codex can reach it).
 *
 *   E2B_API_KEY=… npx tsx --tsconfig server/tsconfig.json \
 *     server/utils/harness/codex-appserver/e2b-probe.mts
 *
 * Costs E2B time only (one box for a few minutes), never model spend. Answers:
 * does the app-server bootstrap and run in the product box; does Tool Approval
 * on pause, approve once, deny cleanly; what an approved command can reach
 * (network, home, files outside the folder, git) under the production hosted
 * policy (`PROBE_ON_POLICY` overrides it); what off runs; memory; and what is
 * left running after.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createE2BHarnessSandboxProvider } from "../e2b-sandbox-provider.js";
import { getHarnessAdapter } from "../registry.js";
import { HOSTED_APPROVAL_SANDBOX_POLICY } from "./hosted-sandbox-policy.js";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("E2B_API_KEY is required");
const TEMPLATE = process.env.PROBE_E2B_TEMPLATE ?? "mcpjam-computer";
const MOCK_PORT = 18080;

type Turn = { text: string; approvals: number; tools: string[]; errors: string[]; ms: number };

async function runTurn(
  label: string,
  agent: any,
  ref: { s: any },
  prompt: string,
  approve: boolean,
): Promise<Turn> {
  const start = Date.now();
  const tools: string[] = [];
  const errors: string[] = [];
  const calls = new Map<string, any>();
  let text = "";
  let approvals = 0;
  let res: any = await agent.stream({ session: ref.s, prompt });
  let stream: AsyncIterable<any> = res.fullStream;
  for (let round = 0; round < 4; round++) {
    let paused: any = null;
    for await (const part of stream) {
      if (part.type === "text-delta") text += part.text ?? part.delta ?? "";
      if (part.type === "tool-call") {
        calls.set(part.toolCallId, part);
        tools.push(String(part.toolName));
      }
      if (part.type === "tool-approval-request") { paused = part; break; }
      if (part.type === "error") errors.push(String(part.error?.message ?? part.error));
    }
    if (!paused) break;
    approvals += 1;
    const tc = calls.get(paused.toolCallId) ?? { toolCallId: paused.toolCallId, toolName: "bash", input: {} };
    const cont = await ref.s.suspendTurn();
    ref.s = await agent.createSession({ sessionId: ref.s.sessionId, continueFrom: cont });
    res = await agent.continueStream({
      session: ref.s,
      toolApprovalContinuations: [{
        approvalResponse: { type: "tool-approval-response", approvalId: paused.approvalId, approved: approve },
        toolCall: { type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input },
      }],
    });
    stream = res.fullStream;
  }
  const turn = { text, approvals, tools, errors, ms: Date.now() - start };
  console.log(`[probe] ${label}: ${JSON.stringify({ ...turn, text: text.slice(0, 300) })}`);
  return turn;
}

const report: Record<string, unknown> = { template: TEMPLATE };
const sbx = await Sandbox.create(TEMPLATE, { apiKey, timeoutMs: 25 * 60_000 });
report.sandboxId = sbx.sandboxId;
console.log(`[probe] box ${sbx.sandboxId} from ${TEMPLATE}`);
const sh = async (cmd: string) => {
  const r = await sbx.commands.run(cmd, { timeoutMs: 120_000 }).catch((e: any) => e.result ?? { stdout: "", stderr: String(e) });
  return `${r.stdout ?? ""}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`.trim();
};
try {
  report.machine = await sh(
    "uname -r; id; nproc; free -m | sed -n 2p; " +
      "echo userns_max=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null); " +
      "echo unpriv_userns=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a); " +
      "echo apparmor_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a); " +
      "echo bwrap=$(command -v bwrap || echo none); unshare -Ur true && echo unshare_user=ok || echo unshare_user=fail; node --version",
  );
  console.log(`[probe] machine:\n${report.machine}`);

  const mockPath = fileURLToPath(new URL("../local/conformance/mock-responses.mjs", import.meta.url));
  await sbx.files.write("/home/user/.probe/mock.mjs", await readFile(mockPath, "utf8"));
  await sbx.commands.run("node /home/user/.probe/mock.mjs > /home/user/.probe/mock.log 2>&1", {
    background: true,
    envs: { MOCK_PORT: String(MOCK_PORT) },
  });
  for (let i = 0; i < 30; i++) {
    if ((await sh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${MOCK_PORT}/v1/models`)).startsWith("200")) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const adapter = getHarnessAdapter("codex");
  report.transport = (adapter as any).transport;
  if ((adapter as any).transport !== "app-server") throw new Error(`expected app-server, got ${(adapter as any).transport}`);
  const provider = createE2BHarnessSandboxProvider({ sandboxId: sbx.sandboxId, apiKey });
  const onPolicy = process.env.PROBE_ON_POLICY
    ? JSON.parse(process.env.PROBE_ON_POLICY)
    : HOSTED_APPROVAL_SANDBOX_POLICY;
  report.onPolicy = onPolicy;
  const newAgent = (permissionMode: "allow-reads" | "allow-all") =>
    new HarnessAgent({
      harness: adapter.createHarness({
        modelId: "openai/gpt-5.5",
        auth: { CODEX_API_KEY: "sk-probe", OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1` },
        ...(permissionMode === "allow-reads" && onPolicy ? { sandboxPolicy: onPolicy } : {}),
      } as any) as any,
      sandbox: provider,
      permissionMode,
      instructions: "You are running a hosted probe.",
    } as any);

  // ── Tool Approval On (allow-reads → untrusted) ────────────────────────────
  const on: any = newAgent("allow-reads");
  const bootStart = Date.now();
  const onRef = { s: await on.createSession() };
  report.bootstrapMs = Date.now() - bootStart;
  const t: Record<string, Turn> = {};
  t.onWrite = await runTurn("on-approve-write", on, onRef, "SHELL printf 'on\\n' >> on-marker.txt && echo WROTE", true);
  report.memoryDuringOn = await sh("free -m | sed -n 2p; ps -eo rss,comm --sort=-rss | head -6");
  t.onNetwork = await runTurn("on-approve-network", on, onRef, "SHELL curl -sS -m 10 -o /dev/null -w 'HTTP=%{http_code}' https://example.com; echo \" EXIT=$?\"", true);
  t.onOutside = await runTurn("on-approve-outside", on, onRef, "SHELL echo outside > /tmp/probe-outside-on.txt; echo EXIT=$?", true);
  t.onHome = await runTurn("on-approve-home", on, onRef, "SHELL mkdir -p ~/.cache/probe && echo home > ~/.cache/probe/home.txt; echo EXIT=$?", true);
  t.onSetsid = await runTurn("on-approve-setsid", on, onRef, "SHELL setsid sleep 4242 >/dev/null 2>&1 < /dev/null & echo STARTED", true);
  t.onGitNested = await runTurn("on-git-nested", on, onRef, "SHELL git init -q nested && cd nested && git -c user.email=p@x -c user.name=p commit -q --allow-empty -m x && echo COMMITTED_NESTED", true);
  t.onGitCwd = await runTurn("on-git-cwd", on, onRef, "SHELL git init -q . && git -c user.email=p@x -c user.name=p commit -q --allow-empty -m x && echo COMMITTED_CWD; git log --oneline | head -1", true);
  t.onGitCwd2 = await runTurn("on-git-cwd-again", on, onRef, "SHELL git -c user.email=p@x -c user.name=p commit -q --allow-empty -m y && echo COMMITTED_CWD_AGAIN", true);
  t.onDeny = await runTurn("on-deny", on, onRef, "SHELL echo denied > denied-marker.txt", false);
  report.onFiles = await sh("find / -xdev \\( -name on-marker.txt -o -name denied-marker.txt -o -name probe-outside-on.txt -o -name home.txt \\) 2>/dev/null | while read f; do echo \"$f: $(cat $f | tr '\\n' '|')\"; done");
  await onRef.s.destroy?.().catch?.(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  report.leftoverAfterOn = await sh("ps -eo pid,ppid,etime,cmd | grep -E 'codex|bridge.mjs|sleep 4242' | grep -v grep || echo none");

  // ── Tool Approval Off (allow-all → never + danger-full-access) ────────────
  const off: any = newAgent("allow-all");
  const offRef = { s: await off.createSession() };
  t.offWrite = await runTurn("off-write", off, offRef, "SHELL printf 'off\\n' >> off-marker.txt && echo WROTE", true);
  t.offNetwork = await runTurn("off-network", off, offRef, "SHELL curl -sS -m 10 -o /dev/null -w 'HTTP=%{http_code}' https://example.com; echo \" EXIT=$?\"", true);
  report.offFiles = await sh("find / -xdev -name off-marker.txt 2>/dev/null | while read f; do echo \"$f: $(cat $f | tr '\\n' '|')\"; done");
  await offRef.s.destroy?.().catch?.(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  report.leftover = await sh("ps -eo pid,ppid,etime,cmd | grep -E 'codex|bridge.mjs' | grep -v grep || echo none");
  report.turns = t;
  report.mockLog = await sh("tail -n 30 /home/user/.probe/mock.log");
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  await sbx.kill().catch(() => {});
  console.log("\n=====REPORT=====\n" + JSON.stringify(report, null, 2));
}

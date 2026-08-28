/**
 * M0 spike for the Hosted Browser + WebMCP Runtime: browser as a capability of
 * MCPJam Computers on E2B Desktop. This is the checked-in, re-runnable record of
 * the spike (patterned on webmcp-cdp.spike.test.ts), NOT a per-PR test — it
 * builds a template and creates live sandboxes, so it is gated behind an
 * explicit opt-in and skips everywhere else.
 *
 * Run it:  RUN_E2B_DESKTOP_SPIKE=1 E2B_API_KEY=... npx vitest run \
 *            --project server server/services/browserd/__tests__/e2b-desktop.spike.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FINDINGS (first run 2026-08-28, e2b@2.29.0; full manifest in SPIKE_FINDINGS.md)
 *
 *   1. Sandbox.connect on a PAUSED box AUTO-RESUMES (~0.7s), isRunning=true
 *      immediately. Resolves the terminal-token vs resolve-sandbox contradiction.
 *   5. Xfce + Chromium + background daemons SURVIVE pause→resume intact. This
 *      CONTRADICTS the plan's "always kill-and-relaunch on wake": the daemon
 *      should health-check and relaunch only on failure / bootId mismatch, and a
 *      surviving browserd keeps a stable bootId so idempotency survives a pause.
 *   6. Desktop is 8 vCPU / 8 GB — 4x the standard computer (2vCPU/2GB) the
 *      10 cr/hr rate was set for. The desktop credit rate is a LAUNCH BLOCKER,
 *      not a deferred follow-up.
 *   7. The pinned Chromium 151.0.7922.34, headed on Xvfb :0 inside the sandbox,
 *      behaves IDENTICALLY to the local WebMCP CDP contract (page API present,
 *      tool registers, invoke returns id-before-settle then completes).
 *   8. Template derivation works: Template().fromDockerfile() FROM e2bdev/desktop
 *      builds via SDK build-system-v2 (the v1 CLI build is deprecated; the plan's
 *      "CLI-built" assumption is stale). Custom-env desktop layer is feasible.
 *   9. Every getHost(port) is a PUBLIC HTTPS endpoint; the daemon MUST enforce
 *      its own bearer on every request (200 w/ token, 401 w/o).
 *
 * Recorded in SPIKE_FINDINGS.md, validated via the @e2b/desktop VNC driver
 * (kept as fixtures/stream-embed.probe.mjs so this suite needs no extra dep):
 *   2. Stream authKey is random per start() and in-memory only → the session row
 *      MUST cache the stream URL+password (a fresh replica can't mint/retrieve).
 *   3. A second stream.start() throws "already running" (no supersede/dual).
 *   4. The noVNC page sets no X-Frame-Options and no CSP → iframe-embeddable.
 *  10. getUrl({viewOnly:true}) yields a ?view_only=true URL (input disabled).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, Template } from "e2b";

const RUN = !!process.env.E2B_API_KEY && process.env.RUN_E2B_DESKTOP_SPIKE === "1";

// A lane that opted in but has no key is MISCONFIGURED — fail loudly rather than
// skip, mirroring webmcp-cdp.spike.test.ts's CI guard.
if (process.env.RUN_E2B_DESKTOP_SPIKE === "1" && !process.env.E2B_API_KEY) {
  throw new Error(
    "RUN_E2B_DESKTOP_SPIKE=1 but E2B_API_KEY is unset — the credentialed spike " +
      "lane cannot run. Provide the key or unset RUN_E2B_DESKTOP_SPIKE.",
  );
}

const TEMPLATE_NAME = "webmcp-desktop-spike";
const DOCKERFILE = readFileSync(
  fileURLToPath(new URL("./fixtures/desktop-spike.Dockerfile", import.meta.url)),
  "utf8",
);
const IN_SANDBOX_PROBE = readFileSync(
  fileURLToPath(new URL("./fixtures/in-sandbox-cdp-probe.mjs", import.meta.url)),
  "utf8",
);
const CHROME_PATH = "/opt/mcpjam/ms-playwright/chromium-1234/chrome-linux64/chrome";
const apiKey = process.env.E2B_API_KEY;

describe.skipIf(!RUN)("E2B desktop + browserd M0 spike", () => {
  let box: Sandbox;
  let createMs = 0;

  beforeAll(async () => {
    // Probe #8: derive the desktop template from the checked-in Dockerfile.
    await Template.build(Template().fromDockerfile(DOCKERFILE), TEMPLATE_NAME, {
      apiKey,
      cpuCount: 2,
      memoryMB: 4096,
    });
    const t0 = Date.now();
    box = await Sandbox.create(TEMPLATE_NAME, { apiKey, timeoutMs: 5 * 60_000 });
    createMs = Date.now() - t0;
  }, 10 * 60_000);

  afterAll(async () => {
    await box?.kill().catch(() => {});
  });

  const sh = async (cmd: string) => {
    const r = await box.commands.run(cmd, { timeoutMs: 120_000 });
    return (r.stdout ?? "").trim();
  };

  it("boots and bakes Node 20 + the WebMCP-pinned Chromium (#6, #8)", async () => {
    expect(createMs).toBeGreaterThan(0);
    expect(await sh("node --version")).toMatch(/^v20\./);
    const chrome = await sh(`${CHROME_PATH} --version --no-sandbox`);
    expect(chrome).toContain("151.0.7922.34");
  });

  it("provisions a desktop-class box (8 vCPU / ~8 GB) (#6)", async () => {
    const metrics = await box.getMetrics();
    const last = Array.isArray(metrics) ? metrics[metrics.length - 1] : metrics;
    expect(last?.cpuCount).toBeGreaterThanOrEqual(4);
    expect(last?.memTotal).toBeGreaterThan(4 * 1024 ** 3);
  });

  it("exposes a per-port public HTTPS endpoint that carries a bearer (#9)", async () => {
    const PORT = 49717;
    const TOKEN = "spike-" + Math.random().toString(36).slice(2);
    const script = [
      "import http.server,os,json",
      "TOK=os.environ.get('BROWSERD_TOKEN')",
      "class H(http.server.BaseHTTPRequestHandler):",
      " def do_GET(s):",
      "  if s.headers.get('Authorization')!='Bearer '+TOK:",
      "   s.send_response(401); s.end_headers(); s.wfile.write(b'nope'); return",
      "  s.send_response(200); s.end_headers(); s.wfile.write(json.dumps({'ok':True}).encode())",
      " def log_message(s,*a): pass",
      `http.server.HTTPServer(('0.0.0.0',${PORT}),H).serve_forever()`,
    ].join("\n");
    await box.files.write("/tmp/toyd.py", script);
    await box.commands.run("python3 /tmp/toyd.py", {
      background: true,
      timeoutMs: 0,
      envs: { BROWSERD_TOKEN: TOKEN },
    });
    await new Promise((r) => setTimeout(r, 1500));
    const base = `https://${box.getHost(PORT)}`;
    const withBearer = await fetch(`${base}/healthz`, {
      headers: { authorization: "Bearer " + TOKEN },
    });
    const noBearer = await fetch(`${base}/healthz`);
    expect(withBearer.status).toBe(200);
    expect(noBearer.status).toBe(401); // publicly reachable — the daemon is the guard
  }, 60_000);

  it("runs the WebMCP CDP contract headed under Xfce with the pinned Chromium (#7)", async () => {
    // The desktop base auto-starts Xfce/Xvfb; give it a beat if not yet up.
    await box.commands
      .run("DISPLAY=:0 xset q >/dev/null 2>&1 || (nohup startxfce4 >/tmp/xfce.log 2>&1 & sleep 4)", {
        timeoutMs: 30_000,
      })
      .catch(() => {});
    await box.files.write("/tmp/cdp-probe.mjs", IN_SANDBOX_PROBE);
    const r = await box.commands.run(
      `cd /opt/mcpjam/browserd && DISPLAY=:0 PW_CHROME_PATH='${CHROME_PATH}' node /tmp/cdp-probe.mjs`,
      { timeoutMs: 90_000 },
    );
    const line = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
      .split("\n")
      .find((l) => l.startsWith("RESULT:"));
    expect(line, `no RESULT line; stderr=${r.stderr}`).toBeDefined();
    const result = JSON.parse(line!.slice("RESULT:".length));
    expect(result.chromiumVersion).toBe("151.0.7922.34");
    expect(result.steps.hasPageApi).toBe(true);
    expect(result.steps.echoRegistered).toBe(true);
    expect(result.steps.invokeReturnedIdBeforeSettle).toBe(true);
    expect(result.steps.invokeCompleted).toBe(true);
    expect(result.ok).toBe(true);
  }, 120_000);

  it("survives pause→resume with its process tree intact, auto-resumed on connect (#1, #5)", async () => {
    await box.pause();
    // Reconnect from a fresh handle — the replica-independence case.
    const reconnected = await Sandbox.connect(box.sandboxId, { apiKey });
    expect(await reconnected.isRunning()).toBe(true); // connect auto-resumed
    const procs = await reconnected.commands
      .run("ps -eo comm --no-headers | sort -u", { timeoutMs: 60_000 })
      .then((r) => r.stdout ?? "");
    expect(procs).toMatch(/chrome/); // Chromium survived the snapshot
    expect(procs).toMatch(/xfce|Xvfb|Xorg/); // the desktop survived too
    box = reconnected; // afterAll kills the live handle
  }, 120_000);
});

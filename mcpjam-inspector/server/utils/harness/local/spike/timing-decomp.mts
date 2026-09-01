// Decompose session-start cost: full-tree digest vs bare bridge spawn-to-listen.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { computeTreeDigest } from "../runtime-identity.js";
const ROOT = process.env.SPIKE_ROOT!; const B = join(ROOT, "runtime", "claude-code");
const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const waitListen = (port: number) => new Promise<number>((resolve) => { const t0 = performance.now(); const tick = () => { const sock = net.connect(port, "127.0.0.1"); sock.once("connect", () => { sock.destroy(); resolve(Math.round(performance.now() - t0)); }); sock.once("error", () => { sock.destroy(); setTimeout(tick, 5); }); }; tick(); });
for (let i = 0; i < 3; i++) { const t = performance.now(); await computeTreeDigest(B); console.log(`digest #${i + 1}: ${Math.round(performance.now() - t)}ms`); }
for (let i = 0; i < 3; i++) {
  const port = await freePort(); const dir = join(ROOT, "timing", `s${i}`); await mkdir(join(dir, "bridge"), { recursive: true });
  const t = performance.now();
  const child = spawn(join(B, "bin", "node"), [join(B, "launcher.mjs"), "--workdir", dir, "--bridge-state-dir", join(dir, "bridge")], { env: { PATH: "/usr/bin:/bin", HOME: dir, BRIDGE_CHANNEL_TOKEN: "t", BRIDGE_WS_PORT: String(port) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const ms = await waitListen(port);
  console.log(`bridge spawn->listen #${i + 1}: ${ms}ms (total ${Math.round(performance.now() - t)}ms)`);
  process.kill(-child.pid!, "SIGKILL");
}

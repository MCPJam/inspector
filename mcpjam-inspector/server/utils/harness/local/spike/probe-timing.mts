import net from "node:net";
import { nonLoopbackLocalAddresses, assertBridgeLoopbackOnly } from "../bridge-endpoint.js";
const addrs = nonLoopbackLocalAddresses();
console.log("non-loopback local addresses:", JSON.stringify(addrs));
const server = net.createServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as net.AddressInfo).port;
for (const a of addrs) {
  const t = performance.now();
  await new Promise<void>((resolve) => { const s = net.connect({ port, host: a.address ?? a, family: (a.family === "IPv6" || String(a).includes(":")) ? 6 : 4 } as any); s.setTimeout(8000); s.once("connect", () => { console.log(`  ${a.address ?? a}: CONNECTED (bad) ${Math.round(performance.now() - t)}ms`); s.destroy(); resolve(); }); s.once("error", (e: any) => { console.log(`  ${a.address ?? a}: ${e.code} ${Math.round(performance.now() - t)}ms`); resolve(); }); s.once("timeout", () => { console.log(`  ${a.address ?? a}: TIMEOUT ${Math.round(performance.now() - t)}ms`); s.destroy(); resolve(); }); });
}
const t2 = performance.now();
await assertBridgeLoopbackOnly({ port, readinessTimeoutMs: 5000, isBridgeAlive: async () => true } as any);
console.log(`assertBridgeLoopbackOnly total: ${Math.round(performance.now() - t2)}ms`);
server.close();

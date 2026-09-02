/**
 * The exposure probe's BUDGET, asserted rather than printed.
 *
 * The defect this exists to keep out was measured: on a laptop with ten
 * link-local addresses the probe took 11 s inside a 1.5 s session-start
 * budget, because it connected to each address in turn. D7 made it parallel
 * and bounded it at `PROBE_BUDGET_MS`; this fails if that comes back.
 */
import net from "node:net";
import {
  nonLoopbackLocalAddresses,
  assertBridgeLoopbackOnly,
} from "../bridge-endpoint.js";

/**
 * What the probe is allowed to cost, with room for a loaded CI runner.
 *
 * `PROBE_BUDGET_MS` inside the probe is 1 s; this is the outer number the
 * session-start SLO actually cares about, and a regression to serial probing
 * blows past it by an order of magnitude rather than a little.
 */
const BUDGET_MS = 3_000;

const addresses = nonLoopbackLocalAddresses();
console.log("non-loopback local addresses:", JSON.stringify(addresses));

const server = net.createServer();
await new Promise<void>((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve()),
);
const port = (server.address() as net.AddressInfo).port;

/**
 * One connect attempt, reported.
 *
 * `addresses` is `string[]` — the earlier version of this loop read
 * `a.address` and `a.family` off it, branches that were always undefined and
 * were hidden by an `as any`.
 */
function probe(address: string): Promise<string> {
  const started = performance.now();
  const family = address.includes(":") ? 6 : 4;
  return new Promise<string>((resolve) => {
    const socket = net.connect({ port, host: address, family });
    const done = (what: string) => {
      socket.destroy();
      resolve(
        `  ${address}: ${what} ${Math.round(performance.now() - started)}ms`,
      );
    };
    // Bounded by the same budget the probe under test uses, and run in
    // parallel with its siblings — otherwise this script would itself take
    // 8 s per firewalled address before reaching the measurement, which is
    // exactly the latency it exists to detect.
    socket.setTimeout(BUDGET_MS);
    socket.once("connect", () => done("CONNECTED (bad)"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(String(error.code)),
    );
    socket.once("timeout", () => done("TIMEOUT"));
  });
}

for (const line of await Promise.all(addresses.map(probe))) console.log(line);

const started = performance.now();
await assertBridgeLoopbackOnly({
  port,
  readinessTimeoutMs: 5_000,
  isBridgeAlive: async () => true,
} as never);
const elapsed = Math.round(performance.now() - started);
console.log(`assertBridgeLoopbackOnly total: ${elapsed}ms`);
server.close();

if (elapsed > BUDGET_MS) {
  console.error(
    `probe-timing: the exposure probe took ${elapsed}ms against a ${BUDGET_MS}ms ` +
      `budget over ${addresses.length} non-loopback address(es). Serial ` +
      `probing is the regression this scenario exists to catch.`,
  );
  process.exit(1);
}

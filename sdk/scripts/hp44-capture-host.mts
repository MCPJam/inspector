/**
 * HP-44 — capture a REAL host's OAuth handshake.
 *
 * Starts the recording MCP resource server + authorization server from
 * `tests/support/oauth-capture-server.ts`, prints the URL to point a host at,
 * and writes a HAR once the handshake goes quiet.
 *
 * Usage:
 *   npx tsx scripts/hp44-capture-host.mts --port 3999 --out /tmp/host.har
 *
 * Then point the host at the printed MCP URL and let it authenticate. The server
 * auto-approves `/authorize`, so no human needs to click anything — the whole
 * dance completes unattended.
 *
 * Why be the endpoint rather than a proxy: a proxy needs TLS interception and a
 * trust-store change on the client, either of which can alter the very behavior
 * we are trying to observe. Being the server records the exact bytes the client
 * chose to send, with nothing in between. The task's "HAR or equivalent" is
 * satisfied more faithfully this way, not less.
 */

import { writeFileSync } from "node:fs";

import { startCaptureServer } from "../tests/support/oauth-capture-server.js";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(arg("port", "3999"));
const out = arg("out", "hp44-capture.har")!;
/** Exit this long after the LAST request, once at least one has arrived. */
const idleMs = Number(arg("idle-ms", "6000"));
/** Hard ceiling, so an unattended run cannot hang forever. */
const timeoutMs = Number(arg("timeout-ms", "120000"));

const server = await startCaptureServer({ port });

console.log(`[hp44] recording server listening on ${server.origin}`);
console.log(`[hp44] point your host at:  ${server.mcpUrl}`);
console.log(`[hp44] scenario id:         ${server.scenario.scenarioId}`);
console.log(`[hp44] writing HAR to:      ${out}`);
console.log(`[hp44] will exit ${idleMs}ms after the last request (max ${timeoutMs}ms)`);

let seen = 0;
let lastCount = 0;
let idleSince = Date.now();
const startedAt = Date.now();

function finish(reason: string): never {
  const har = server.har();
  writeFileSync(out, JSON.stringify(har, null, 2), "utf8");
  console.log(
    `[hp44] ${reason}: wrote ${har.log.entries.length} entries to ${out}`,
  );
  for (const entry of har.log.entries) {
    console.log(
      `[hp44]   ${entry.response.status} ${entry.request.method} ${entry.request.url}`,
    );
  }
  process.exit(0);
}

process.on("SIGINT", () => finish("interrupted"));

const tick = setInterval(() => {
  const count = server.requestCount();
  if (count !== lastCount) {
    lastCount = count;
    seen = count;
    idleSince = Date.now();
    console.log(`[hp44] ${count} request(s) recorded`);
  }
  if (seen > 0 && Date.now() - idleSince > idleMs) {
    clearInterval(tick);
    finish("handshake went quiet");
  }
  if (Date.now() - startedAt > timeoutMs) {
    clearInterval(tick);
    finish(seen > 0 ? "timeout reached" : "timeout reached with NO requests");
  }
}, 500);

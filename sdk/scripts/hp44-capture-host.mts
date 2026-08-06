/**
 * HP-44 — capture a REAL host's OAuth handshake.
 *
 * Starts the recording MCP resource server + authorization server from
 * `tests/support/oauth-capture-server.ts`, prints the URL to point a host at,
 * and writes the capture once the handshake goes quiet.
 *
 * Usage:
 *   npx tsx scripts/hp44-capture-host.mts --port 3999 --out /tmp/host.har
 *
 * Then point the host at the printed MCP URL and let it authenticate. The server
 * auto-approves `/authorize`, so no human needs to click anything — the whole
 * dance completes unattended.
 *
 * Two artifacts come out, and the asymmetry is deliberate:
 *
 *   - the REDACTED golden trace (`--trace-out`), always. Built with
 *     `captureHarTrace`, so it goes through the same normalization and
 *     `assertTraceIsRedacted` gate as every committed trace.
 *   - the RAW HAR (`--out`), only when it contains nothing secret-shaped. It is
 *     unredacted by construction — the exact bytes the host sent is the point of
 *     the capture and also the hazard, since a host configured with a real
 *     `client_secret` or `software_statement` would otherwise have it written to
 *     disk. In practice any capture that reached `/token` trips the detector, so
 *     expect it to be withheld; pass `--keep-raw-har` to accept the risk when you
 *     need to re-ingest through `mcpjam oauth trace ingest-har` for provenance
 *     this script does not take (resolved OAuth dependency, surface, notes).
 *
 * Why be the endpoint rather than a proxy: a proxy needs TLS interception and a
 * trust-store change on the client, either of which can alter the very behavior
 * we are trying to observe. Being the server records the exact bytes the client
 * chose to send, with nothing in between. The task's "HAR or equivalent" is
 * satisfied more faithfully this way, not less.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  captureHarTrace,
  findRedactionViolations,
  formatHarIngestReportHuman,
  formatTraceSummaryHuman,
} from "../src/oauth-golden-trace/index.js";
import { redactSensitiveValue } from "../src/redaction.js";
import {
  startCaptureServer,
  type CaptureServer,
} from "../tests/support/oauth-capture-server.js";

/**
 * Read `--name <value>` from argv.
 *
 * A bare flag at the end of argv, or one immediately followed by another flag,
 * has NO value — taking the next token would otherwise make `--host --out x`
 * bind to the interface `"--out"`, and `--host-id --operator me` stamp the
 * catalog id `"--operator"` into a committed trace. Both are silent: the run
 * completes and the artifact is wrong. Treat it as absent, say so, and let the
 * caller's default stand. {@link numberArg} and {@link urlArg} layer their own
 * validation on top of this.
 */
function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value == null || value.startsWith("--")) {
    console.error(
      `[hp44] --${name} was passed with no value${value == null ? " (end of arguments)" : ` (followed by \`${value}\`)`}.${fallback == null ? " Ignoring it." : ` Using \`${fallback}\`.`}`,
    );
    return fallback;
  }
  return value;
}

/**
 * `arg` already rejects a missing or flag-shaped value, but a present-and-wrong
 * one (`--timeout-ms abc`) still reaches here, and `Number` turns it into `NaN`,
 * against which every comparison is false — so a bad `--timeout-ms` would
 * silently delete the hard ceiling this script advertises and the unattended run
 * that can never hang, hangs. Fall back to the default instead, loudly, so the
 * guarantee holds no matter what argv looked like.
 */
function numberArg(name: string, fallback: number): number {
  const raw = arg(name);
  const value = raw == null || raw.startsWith("--") ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    // Only complain when the flag was actually passed — its absence is the
    // ordinary case and the default is the documented answer to it.
    if (process.argv.includes(`--${name}`)) {
      console.error(
        `[hp44] --${name} needs a finite, non-negative number; got ${raw == null ? "no value" : `\`${raw}\``}. Using ${fallback}.`,
      );
    }
    return fallback;
  }
  return value;
}

/**
 * Same argv hazard as {@link numberArg}, with a worse failure mode.
 *
 * A bare `--public-origin` takes the NEXT FLAG as its value, and that string then
 * becomes the origin of every URL this server advertises — the PRM `resource`, the
 * AS metadata endpoints, the 401 challenge pointer. The capture would either not
 * happen or record a handshake against a host that never existed. Unlike a bad
 * `--timeout-ms` there is no safe default to fall back to, so this exits.
 */
function urlArg(name: string): string | undefined {
  if (!process.argv.includes(`--${name}`)) return undefined;
  const raw = arg(name);
  let parsed: URL | undefined;
  try {
    parsed = raw == null ? undefined : new URL(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    console.error(
      `[hp44] --${name} needs an absolute http(s) URL; got ${raw == null ? "no value" : `\`${raw}\``}. Pass the tunnel's URL, e.g. --${name} https://example.ngrok.app`,
    );
    process.exit(2);
  }
  return raw;
}

const port = numberArg("port", 3999);
/** Bind interface. Use 0.0.0.0 when a tunnel needs to reach us from outside. */
const host = arg("host", "127.0.0.1")!;
/**
 * Public base URL the CLIENT will use, when it differs from where we bind.
 *
 * Required for any HOSTED client — Slack, ChatGPT, Claude.ai web, Mistral, Notion,
 * Perplexity, M365 Copilot. Those perform OAuth from the vendor's own
 * infrastructure, so `127.0.0.1` resolves to their server and the handshake never
 * reaches us. Put a tunnel in front and pass its https URL here.
 */
const publicOrigin = urlArg("public-origin");
const out = arg("out", "hp44-capture.har")!;
/** Catalog host id being captured. Stamped into the trace id. */
const hostId = arg("host-id", "unknown-host")!;
/** Omitting it stamps `not-observed`, which the differ reports as a gap. */
const hostVersion = arg("host-version");
const operator = arg("operator");
const traceOut = arg("trace-out", `${out.replace(/\.har$/i, "")}.trace.json`)!;
/** Write the raw HAR even when it holds secret-shaped values. See the header. */
const keepRawHar = process.argv.includes("--keep-raw-har");
/** Exit this long after the LAST request, once at least one has arrived. */
const idleMs = numberArg("idle-ms", 6000);
/** Hard ceiling, so an unattended run cannot hang forever. */
const timeoutMs = numberArg("timeout-ms", 120000);

// `--out` and `--trace-out` naming the SAME file is not two artifacts racing —
// `finish()` writes `traceOut` first and `out` second, so a collision means the
// raw, unredacted HAR silently overwrites the redacted trace on disk, which is
// the exact inversion of the asymmetry this script's header promises. Cheaper
// to reject at startup than to write both and let the last one win.
if (resolve(traceOut) === resolve(out)) {
  console.error(
    `[hp44] --out and --trace-out resolve to the same path (${resolve(out)}). Writing both would leave the raw HAR sitting where the redacted trace was supposed to be. Pass two different paths.`,
  );
  process.exit(2);
}

const server = await startCaptureServer({
  port,
  host,
  ...(publicOrigin ? { publicOrigin } : {}),
});

console.log(`[hp44] bound on ${host}:${port}`);
console.log(`[hp44] advertising itself as ${server.origin}`);
if (!publicOrigin) {
  console.log(
    "[hp44] NOTE: no --public-origin, so only LOCAL clients can reach this. Hosted clients (Slack, ChatGPT, Claude.ai, Mistral, Notion, Perplexity, M365 Copilot) run OAuth from the vendor's own servers and cannot see 127.0.0.1 — put an https tunnel in front and pass --public-origin.",
  );
}
console.log(`[hp44] point your host at:  ${server.mcpUrl}`);
console.log(`[hp44] scenario id:         ${server.scenario.scenarioId}`);
console.log(`[hp44] writing trace to:    ${traceOut}`);
console.log(`[hp44] writing HAR to:      ${out} (only if it holds no secrets)`);
console.log(`[hp44] will exit ${idleMs}ms after the last request (max ${timeoutMs}ms)`);

let lastCount = 0;
let idleSince = Date.now();
const startedAt = Date.now();

/**
 * Requests accepted but not yet answered.
 *
 * `requestCount()` only sees COMPLETED entries, so idling on it alone can cut the
 * capture off while a request is still having its body read — the `/token` POST
 * being the likely victim, and losing it produces a golden trace that is WRONG
 * rather than merely short, because a missing leg reads as `not-observed`. The
 * raw server's `request` event fires as soon as headers are parsed, which is
 * early enough to hold the door open, and `close` fires even for an aborted
 * response so the counter cannot leak.
 */
let inFlight = 0;
server.raw.on("request", (_request, response) => {
  inFlight += 1;
  idleSince = Date.now();
  response.once("close", () => {
    inFlight -= 1;
    idleSince = Date.now();
  });
});

function buildTrace(har: ReturnType<typeof server.har>) {
  try {
    return captureHarTrace({
      har,
      hostId,
      scenario: server.scenario,
      ...(hostVersion ? { hostVersion } : {}),
      ...(operator ? { operator } : {}),
    });
  } catch (error) {
    // `captureHarTrace` runs `assertTraceIsRedacted`, so landing here means the
    // capture still carries something secret-shaped after normalization. Writing
    // nothing is the correct outcome: the whole point of the gate is that a
    // secret never reaches disk.
    console.error(
      `[hp44] the capture could not be turned into a redacted trace, so NOTHING was written: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

/**
 * Catches what {@link findRedactionViolations} structurally cannot.
 *
 * `findRedactionViolations` is shape-based over an ALREADY-PARSED trace, where a
 * secret has been split out into its own string value under some key — so it
 * looks for `key=value` and JWT/Bearer shapes as strings in their own right. The
 * raw HAR is not that: `postData.text` is the wire's raw bytes as ONE string, and
 * a JSON-encoded secret in there reads `"access_token":"eyJ…"` — colon-and-quotes,
 * never `key=value` — so the shape scan walks straight past it.
 *
 * `redactSensitiveValue` already has a rule for exactly that syntax (it is what
 * catches `body.json` fields during normalization), so this reuses it as a
 * detector: redact each raw string in isolation and treat any change as a hit.
 * It cannot fix the raw HAR — redacting in place would defeat the point of a RAW
 * capture — only prove whether it is safe to write one.
 */
function findStructuredSecrets(har: ReturnType<CaptureServer["har"]>): string[] {
  const hits: string[] = [];
  const check = (label: string, text: string | undefined): void => {
    if (!text) return;
    if (redactSensitiveValue(text) !== text) hits.push(label);
  };
  for (const entry of har.log.entries) {
    const where = `${entry.request.method} ${entry.request.url}`;
    check(`${where}: url`, entry.request.url);
    check(`${where}: request body`, entry.request.postData?.text);
    check(`${where}: response body`, entry.response.content?.text);
  }
  return hits;
}

function finish(reason: string): never {
  const har = server.har();
  const entries = har.log.entries;

  if (entries.length === 0) {
    // Automation has to be able to tell "the host never connected" from a
    // capture that worked, and an empty HAR is not an artifact worth writing.
    console.error(
      `[hp44] ${reason}: NO requests were recorded, so nothing was written. Check that the host is pointed at ${server.mcpUrl}${
        publicOrigin
          ? ""
          : " and that it can actually reach 127.0.0.1 — a hosted client cannot, so pass --public-origin with a tunnel URL"
      }.`,
    );
    process.exit(1);
  }

  // Build the trace BEFORE writing anything: it is the redaction gate, and a
  // capture that fails it must not leave a half-written artifact behind.
  const { trace, report } = buildTrace(har);
  writeFileSync(traceOut, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  console.log(`[hp44] ${reason}: wrote ${trace.wire.length} exchange(s) to ${traceOut}`);
  console.log(formatTraceSummaryHuman(trace));
  console.log(formatHarIngestReportHuman(report));

  const violations = findRedactionViolations(har);
  // Shape-based scan plus the key-aware one: `findRedactionViolations` walks
  // parsed values looking for `key=value` and token shapes, but the raw HAR's
  // bodies are un-parsed wire bytes, where a JSON secret reads `"key":"value"`
  // and the shape scan walks past it. See {@link findStructuredSecrets}.
  const structuredHits = findStructuredSecrets(har);
  const detail = [
    ...violations.map((violation) => `${violation.path}: ${violation.pattern}`),
    ...structuredHits.map((hit) => `${hit}: structured secret field`),
  ].join("; ");
  const hitCount = violations.length + structuredHits.length;
  if (hitCount === 0) {
    writeFileSync(out, JSON.stringify(har, null, 2), "utf8");
    console.log(`[hp44] raw HAR (${entries.length} entries) written to ${out}`);
  } else if (keepRawHar) {
    writeFileSync(out, JSON.stringify(har, null, 2), "utf8");
    console.error(
      `[hp44] --keep-raw-har: wrote the UNREDACTED HAR to ${out}, and it contains ${hitCount} secret-shaped value(s) (${detail}). Do not commit it.`,
    );
  } else {
    console.error(
      `[hp44] the raw HAR was WITHHELD: it contains ${hitCount} secret-shaped value(s) that only the trace pipeline redacts (${detail}). Use ${traceOut}, or pass --keep-raw-har if you accept the risk.`,
    );
  }

  for (const entry of entries) {
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
    idleSince = Date.now();
    console.log(`[hp44] ${count} request(s) recorded`);
  }
  // `inFlight === 0` is what makes the idle window mean "the host stopped
  // talking" rather than "the host has not finished this request yet".
  if (count > 0 && inFlight === 0 && Date.now() - idleSince > idleMs) {
    clearInterval(tick);
    finish("handshake went quiet");
  }
  if (Date.now() - startedAt > timeoutMs) {
    clearInterval(tick);
    if (inFlight > 0) {
      console.error(
        `[hp44] hard timeout hit with ${inFlight} request(s) still in flight — the capture is TRUNCATED and its last leg(s) will read as not-observed. Re-run with a larger --timeout-ms.`,
      );
    }
    finish(count > 0 ? "timeout reached" : "timeout reached with NO requests");
  }
}, 500);

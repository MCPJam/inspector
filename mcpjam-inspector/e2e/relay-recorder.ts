import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TelemetryPolicyContextIds } from "../server/services/telemetry-privacy-policy";
import type { Hono } from "hono";

// Bundle the real server modules exactly as production does (including JSON),
// while keeping vendor libraries external. Playwright's TS loader cannot load
// their JSON imports directly under Node 24.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relayModule = (async () => {
  const outfile = resolve(packageRoot, `node_modules/.cache/telemetry-relay-${process.pid}.mjs`);
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    stdin: { contents: 'export { Hono } from "hono"; export { default as relayRoutes, relayBodyLimit } from "./server/routes/relay.ts"; export { setTelemetryPolicyQueryForTests } from "./server/services/telemetry-privacy-policy.ts";', resolveDir: packageRoot },
    outfile, bundle: true, platform: "node", format: "esm", packages: "external",
    tsconfig: resolve(packageRoot, "server/tsconfig.json"),
  });
  return import(pathToFileURL(outfile).href) as Promise<{
    Hono: typeof Hono; relayRoutes: Hono; relayBodyLimit: typeof import("../server/routes/relay").relayBodyLimit;
    setTelemetryPolicyQueryForTests: typeof import("../server/services/telemetry-privacy-policy").setTelemetryPolicyQueryForTests;
  }>;
})();

export interface RecordedRelayRequest { url: URL; headers: Record<string, string>; json: unknown; body: Uint8Array }
type PolicyQuery = (context: TelemetryPolicyContextIds) => Promise<unknown>;
let pending = Promise.resolve();

/** Exercise the real relay; only its vendor fetch is replaced with a local recorder. */
export async function recordRelayEgress(input: {
  url: string; method: string; headers: Record<string, string>; body: Buffer | null;
}, query: PolicyQuery, record: (request: RecordedRelayRequest) => void): Promise<void> {
  const run = pending.then(async () => {
    const { Hono, relayRoutes, relayBodyLimit, setTelemetryPolicyQueryForTests } = await relayModule;
    const originalFetch = globalThis.fetch;
    const originalDnt = process.env.DO_NOT_TRACK;
    process.env.DO_NOT_TRACK = "1";
    setTelemetryPolicyQueryForTests(async (_url, _token, context) => query(context));
    globalThis.fetch = async (url, options) => {
      const upstream = new URL(String(url));
      if (upstream.origin !== "https://us.i.posthog.com") throw new Error("unexpected relay destination");
      const raw = options?.body;
      if (!(raw instanceof Uint8Array) && typeof raw !== "string") throw new Error("missing relay payload");
      const { gunzipSync } = await import("node:zlib");
      const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
      const json = JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString());
      record({ url: upstream, headers: Object.fromEntries(new Headers(options?.headers)), json, body: bytes });
      return new Response('{"status":1}');
    };
    try {
      const app = new Hono();
      app.use("/tlm/*", relayBodyLimit());
      app.route("/tlm", relayRoutes);
      app.route("/relay", relayRoutes);
      const response = await app.request(input.url, { method: input.method, headers: input.headers, ...(input.body ? { body: new Uint8Array(input.body) } : {}) });
      if (response.status !== 200) {
        const reason = await response.text();
        // An unsupported strict batch is deliberately dropped by the real
        // boundary. Positive controls still require approved vendor rows.
        if (response.status !== 400 || reason !== '{"error":"telemetry_restricted"}')
          throw new Error(`relay rejected fixture: ${response.status} ${reason}`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalDnt === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = originalDnt;
      setTelemetryPolicyQueryForTests(null);
    }
  });
  // Keep the queue usable after a failure; the caller still receives run's rejection.
  pending = run.then(() => undefined, () => undefined);
  return run;
}

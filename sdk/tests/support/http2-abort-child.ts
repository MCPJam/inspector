/**
 * Child process for `http1-fetch.test.ts`, which records the HTTP version of
 * every request the server sees. Every mode outlives undici's four-second
 * HTTP/2 idle reaper, which is what crashes the process on Node 26's HTTP/2
 * path (nodejs/undici#6143); the parent asserts this process exits 0.
 *
 * - `plain`: one plain `fetch`.
 * - `http1Fetch`: one request through `http1Fetch`, then one aborted in the
 *   same tick it starts, then the idle wait, then one plain `fetch`, which
 *   must still negotiate HTTP/2: the process-wide dispatcher is untouched.
 * - `runConformance`: the CLI's entry point with its defaults (protocol, apps
 *   and tasks; auto-detected version), then the idle wait.
 * - `oauthAuto`: the same entry point running only the OAuth suite with the
 *   CLI's default `registrationStrategy: "auto"`, whose registration probe
 *   dials the MCP server before the suite starts. Headless, so nothing opens
 *   a browser.
 *
 * The test bundles this file with esbuild and runs it: `<bundle> <origin> <mode>`.
 */
// Through the package entry, which loads modules in the order the published
// build does; importing `conformance-run.ts` alone trips a circular import.
import { runConformance } from "../../src/index.js";
import { http1Fetch } from "../../src/http1-fetch.js";

const [origin, mode] = process.argv.slice(2);
const outliveIdleReaper = () =>
  new Promise((resolve) => setTimeout(resolve, 5_500));

if (mode === "plain") {
  await (await fetch(`${origin}/plain`)).text();
}

if (mode === "http1Fetch") {
  await (await http1Fetch(`${origin}/http1`)).text();
  const controller = new AbortController();
  const aborted = http1Fetch(`${origin}/http1`, { signal: controller.signal });
  controller.abort();
  await aborted.then(
    (response) => response.body?.cancel(),
    (error: unknown) => {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    }
  );
  await outliveIdleReaper();
  await (await fetch(`${origin}/global`)).text();
}

if (mode === "runConformance") {
  // The fake server answers just enough JSON-RPC to be dialled; whether the
  // suites pass is not the point, only how they reach it.
  await runConformance({
    server: { url: `${origin}/mcp` },
    protocol: { checkTimeout: 2_000 },
    __suppressTelemetry: true,
  });
  await outliveIdleReaper();
}

if (mode === "oauthAuto") {
  await runConformance({
    server: { url: `${origin}/mcp` },
    suites: ["oauth"],
    oauth: {
      serverUrl: `${origin}/mcp`,
      protocolVersion: "2025-11-25",
      registrationStrategy: "auto",
      auth: { mode: "headless" },
      allowPrivateNetwork: true,
      stepTimeout: 2_000,
    },
    __suppressTelemetry: true,
  });
  await outliveIdleReaper();
}

process.exit(0);

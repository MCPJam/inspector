import { Buffer } from "node:buffer";
import {
  standInTelemetryPolicy,
  TELEMETRY_ACTOR_ID,
} from "../../../../../e2e/telemetry/convex-stand-in";
import { sinkOf, type CapturedRequest } from "../../../../../e2e/telemetry/egress";

export const RELAY_PROJECT_ID = "k17telemetrye2eproject000001";
export { TELEMETRY_ACTOR_ID };

/** First-party ingress is intentionally raw; only final vendor bytes are scanned. */
export function vendorRecorder() {
  const requests: CapturedRequest[] = [];
  let pending = Promise.resolve();
  return {
    requests,
    async receive(input: CapturedRequest) {
      if (sinkOf(input.url) === "sentry") requests.push(input);
      const url = new URL(input.url);
      if (
        sinkOf(input.url) !== "posthog" ||
        !/^\/(tlm|relay)\/(e|i\/v0\/e|s)\/?$/.test(url.pathname)
      ) return;
      const run = pending.then(async () => {
        const { Hono } = await import("hono");
        const { default: relayRoutes, relayBodyLimit } =
          await import("../../../../../server/routes/relay");
        const { setTelemetryPolicyQueryForTests } =
          await import("../../../../../server/services/telemetry-privacy-policy");
        const originalFetch = globalThis.fetch;
        setTelemetryPolicyQueryForTests(async (_url, _token, context) =>
          standInTelemetryPolicy(context));
        globalThis.fetch = async (destination, options) => {
          const upstream = new URL(String(destination));
          if (upstream.origin !== "https://us.i.posthog.com")
            return originalFetch(destination, options);
          const body = options?.body;
          if (!(body instanceof Uint8Array) && typeof body !== "string")
            throw new Error("missing relay payload");
          requests.push({
            url: upstream.toString(),
            method: input.method,
            transport: "fetch",
            headers: Object.fromEntries(new Headers(options?.headers)),
            body: typeof body === "string" ? Buffer.from(body) : body,
          });
          return new Response('{"status":1}');
        };
        try {
          const app = new Hono();
          app.use("/tlm/*", relayBodyLimit());
          app.route("/tlm", relayRoutes);
          app.route("/relay", relayRoutes);
          const response = await app.request(input.url, {
            method: input.method,
            headers: input.headers,
            ...(input.body ? { body: Buffer.from(input.body) } : {}),
          });
          if (
            response.status !== 200 &&
            !(response.status === 400 && await response.text() === '{"error":"telemetry_restricted"}')
          ) throw new Error(`relay rejected fixture: ${response.status}`);
        } finally {
          globalThis.fetch = originalFetch;
          setTelemetryPolicyQueryForTests(null);
        }
      });
      // The caller receives failures; subsequent requests still get evaluated.
      pending = run.then(() => undefined, () => undefined);
      await run;
    },
  };
}

/**
 * PLB-580 spike routes, mounted at `/api/web/claude-live-spike`. Draft only.
 *
 *  - `ALL /mcp`: the URL added as a claude.ai custom connector. It needs the
 *    connector secret header and a live turn, then forwards the request
 *    unchanged to the configured test server and records every frame.
 *  - `POST /turn` `{ live, label? }`: the operator starts a turn before a
 *    prompt and stops it after. Needs the control secret.
 *  - `GET /records`: everything recorded, per turn. Needs the control secret.
 *
 * Every route answers 404 unless the spike's environment is set, so the
 * branch can be deployed to a dev environment without exposing anything else.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { forwardNativeMcp } from "../../utils/harness/forwarding/native-transport.js";
import {
  NativeWireError,
  parseNativeMessage,
  readNativeBody,
  type NativeMessage,
} from "../../utils/harness/forwarding/native-wire.js";
import {
  createClaudeLiveSpikeRecorder,
  readClaudeLiveSpikeConfig,
  secretMatches,
  SPIKE_CONTROL_HEADER,
  SPIKE_KEY_HEADER,
  type ClaudeLiveSpikeConfig,
} from "../../utils/harness/forwarding/claude-live-spike.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

/** A JSON-RPC server error code; claude.ai shows the message on the failed call. */
const NO_LIVE_TURN_CODE = -32001;
const NO_LIVE_TURN_MESSAGE =
  "No MCPJam test turn is running. Start a turn, then send the prompt again.";

/** The only headers an MCP answer keeps; see `claudeLiveSpikeResponseCleanup`. */
const MCP_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
  "cache-control",
  "last-event-id",
];

/**
 * claude.ai stops after `initialize` when the app's global headers ride along:
 * a raw server sending the same set fails the same way. Registered before
 * every other middleware, so it runs last and sees the final answer. It keeps
 * only the MCP server's own headers and streams the body, as a raw server does.
 */
export const claudeLiveSpikeResponseCleanup: MiddlewareHandler = async (c, next) => {
  await next();
  if (!/\/mcp$/.test(c.req.path)) return;
  const answer = c.res;
  const headers = new Headers();
  for (const name of MCP_RESPONSE_HEADERS) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const body = answer.body
    ? answer.body.pipeThrough(new TransformStream())
    : null;
  // Clearing first stops Hono from copying the old headers onto the new answer.
  c.res = undefined;
  c.res = new Response(body, { status: answer.status, headers });
};

const turnBody = z.object({
  live: z.boolean(),
  label: z.string().max(200).optional(),
});

export function createClaudeLiveSpikeRouter(
  options: {
    /** Defaults to the environment; pass `undefined` explicitly to disable. */
    config?: ClaudeLiveSpikeConfig | undefined;
    fetch?: typeof fetch;
  } = {},
) {
  const router = new Hono();
  const config =
    "config" in options ? options.config : readClaudeLiveSpikeConfig();
  if (!config) {
    router.all("*", (c) => c.json({ error: "Not found" }, 404));
    return router;
  }
  const upstreamFetch = options.fetch ?? fetch;
  const recorder = createClaudeLiveSpikeRecorder(config);
  const controlled = (header: string | undefined) =>
    secretMatches(header, config.controlSecret);

  router.post("/turn", async (c) => {
    if (!controlled(c.req.header(SPIKE_CONTROL_HEADER)))
      return c.json({ error: "Unauthorized" }, 401);
    let input: unknown = null;
    try {
      input = await c.req.json();
    } catch {
      // A body that is not JSON fails the schema below with the same answer.
    }
    const parsed = turnBody.safeParse(input);
    if (!parsed.success)
      return c.json(
        { error: "Send { live: true | false, label?: string }." },
        400,
      );
    if (!parsed.data.live) return c.json({ ended: recorder.stop() ?? null });
    recorder.stop();
    return c.json({ live: recorder.start(parsed.data.label) });
  });

  router.get("/records", (c) => {
    if (!controlled(c.req.header(SPIKE_CONTROL_HEADER)))
      return c.json({ error: "Unauthorized" }, 401);
    return c.json(recorder.snapshot());
  });

  // claude.ai sends only custom header names Anthropic has approved, so the
  // secret is also accepted as a bearer token or in the path (`/k/<secret>/mcp`).
  const presentedKey = (c: {
    req: { header(name: string): string | undefined; param(name: string): string | undefined };
  }) => {
    const auth = c.req.header("authorization")?.trim();
    const bearer = auth ? (/^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? auth) : undefined;
    return c.req.header(SPIKE_KEY_HEADER) ?? bearer ?? c.req.param("key");
  };

  router.on(["POST", "GET", "DELETE"], ["/mcp", "/k/:key/mcp"], async (c) => {
    const request = c.req.raw;
    if (!secretMatches(presentedKey(c), config.connectorSecret)) {
      // Names only: shows which headers the host actually sent, never their values.
      const names: string[] = [];
      request.headers.forEach((_value, name) => names.push(name));
      // The authorization header's shape (first word, length), never its value.
      const auth = request.headers.get("authorization");
      // Without a space the first word is the credential itself, so it is not shown.
      const shape = auth
        ? `; authorization: ${
            auth.trim().includes(" ")
              ? `scheme "${auth.trim().split(/\s+/)[0].slice(0, 12)}"`
              : "no scheme"
          }, ${auth.length} chars`
        : "";
      recorder.refused(
        request,
        `unauthorized; headers: ${names.sort().join(", ")}${shape}`,
      );
      return c.json({ error: "Unauthorized" }, 401);
    }

    let raw: string | undefined;
    let message: NativeMessage | undefined;
    try {
      raw = request.method === "POST" ? await readNativeBody(request) : undefined;
      message =
        raw === undefined ? undefined : parseNativeMessage(raw, request.headers);
    } catch (error) {
      if (error instanceof NativeWireError)
        return c.json({ error: "The MCP request is not valid JSON-RPC." }, 400);
      throw error;
    }

    const turn = recorder.liveTurn();
    if (!turn) {
      recorder.refused(request, message?.method ?? request.method);
      const id = message?.id;
      if (message?.method && (typeof id === "string" || typeof id === "number"))
        return c.json({
          jsonrpc: "2.0",
          id,
          error: { code: NO_LIVE_TURN_CODE, message: NO_LIVE_TURN_MESSAGE },
        });
      return c.json({ error: NO_LIVE_TURN_MESSAGE }, 409);
    }

    recorder.request(turn, request, message?.method);
    try {
      return await forwardNativeMcp({
        url: config.upstreamUrl,
        serverId: config.serverId,
        request,
        body: raw,
        message,
        fetch: upstreamFetch,
        rpcLogger: recorder.rpcLogger(turn),
      });
    } catch (error) {
      reportRouteFailure("Claude live spike forwarding failed", error, {
        source: "web.claude-live-spike",
        hop: "user_server_hop",
      });
      return c.json(
        { error: "The test server did not answer. Check that it is running." },
        502,
      );
    }
  });

  return router;
}

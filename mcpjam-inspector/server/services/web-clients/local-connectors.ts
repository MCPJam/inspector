/**
 * Capability connectors registered on a local Inspector, so a person or an
 * agent can run the forwarding endpoint on a laptop behind a tunnel and point
 * Claude web or ChatGPT web at a local MCP server (see
 * `docs/web-clients-forwarding.md`). Local mode only: the routes are mounted
 * only when the Inspector runs locally, behind its session token, and the
 * registry lives in this process.
 *
 * The connector id is the credential, so it is long and random, and the
 * upstream's headers stay here and are never echoed back.
 */
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { webConnectorPath } from "../../../shared/web-clients.js";
import { verifiedFlagSubject } from "../../utils/flag-identity.js";
import type {
  UpstreamTarget,
  WebConnector,
  WebConnectorResolver,
} from "./connectors.js";
import { webClientsEnabledFor } from "./endpoint-auth.js";
import {
  TurnWindowConflictError,
  webClientTurnWindows,
  type TurnWindowStore,
} from "./turn-windows.js";

export function createLocalConnectorRegistry() {
  const entries = new Map<
    string,
    { connector: WebConnector; upstream: UpstreamTarget; flagSubject?: string }
  >();
  const resolver: WebConnectorResolver = {
    async resolve(connectorId) {
      return entries.get(connectorId)?.connector;
    },
    async upstream(connector) {
      const entry = entries.get(connector.connectorId);
      if (!entry) throw new Error("This local connector was removed.");
      return entry.upstream;
    },
    async mayUse() {
      return true;
    },
  };
  return {
    resolver,
    has: (connectorId: string) => entries.has(connectorId),
    /**
     * `web-clients-enabled` as it is now for whoever registered the
     * connector, so turning the flag off stops one already registered.
     */
    async enabled(connectorId: string): Promise<boolean> {
      const entry = entries.get(connectorId);
      return entry !== undefined && (await webClientsEnabledFor(entry.flagSubject));
    },
    register(
      input: {
        upstreamUrl: string;
        headers?: Record<string, string>;
        serverId?: string;
      },
      /** The signed-in person whose flag allowed it; without one, the flag file's. */
      flagSubject?: string,
    ): WebConnector {
      const connector: WebConnector = {
        connectorId: randomBytes(24).toString("base64url"),
        projectId: "local",
        // Frames are filed under this id in the Logs panel.
        serverId: input.serverId ?? "web-connector",
        auth: "capability",
      };
      entries.set(connector.connectorId, {
        connector,
        upstream: { url: input.upstreamUrl, headers: input.headers ?? {} },
        ...(flagSubject ? { flagSubject } : {}),
      });
      return connector;
    },
    /**
     * Replaces a connector's upstream headers, so a refreshed token reaches
     * the connector the vendor's app already saved. False once it is gone.
     */
    setHeaders(connectorId: string, headers: Record<string, string>): boolean {
      const entry = entries.get(connectorId);
      if (!entry) return false;
      entry.upstream = { ...entry.upstream, headers };
      return true;
    },
    remove: (connectorId: string) => entries.delete(connectorId),
    list: () =>
      [...entries.values()].map(({ connector, upstream }) => ({
        connectorId: connector.connectorId,
        path: webConnectorPath(connector.connectorId),
        serverId: connector.serverId,
        upstreamUrl: upstream.url,
      })),
  };
}

export type LocalConnectorRegistry = ReturnType<
  typeof createLocalConnectorRegistry
>;

/** The registry this process's endpoint reads. */
export const localWebConnectors = createLocalConnectorRegistry();

const registration = z
  .object({
    upstreamUrl: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//i.test(url)),
    headers: z.record(z.string(), z.string()).optional(),
    serverId: z.string().min(1).max(200).optional(),
  })
  .strict();
const turnRequest = z
  .object({ allowTools: z.array(z.string().min(1)).optional() })
  .strict();

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    // A body that is not JSON fails the schema with the same answer.
    return undefined;
  }
}

/** The signed-in person a request names, whose flag applies to it. */
async function flagSubject(c: Context): Promise<string | undefined> {
  const token = /^Bearer\s+(\S+)/i.exec(c.req.header("authorization") ?? "")?.[1];
  const identity = token ? await verifiedFlagSubject(token) : undefined;
  return identity?.kind === "id" ? identity.distinctId : undefined;
}

/** The flag for the signed-in person when the request names one, else the flag file. */
async function flagOn(c: Context): Promise<boolean> {
  return webClientsEnabledFor(await flagSubject(c));
}

/**
 * `POST /` registers `{ upstreamUrl, headers?, serverId? }`; `GET /` lists;
 * `DELETE /:connectorId` removes. `POST /:connectorId/turn` opens a turn
 * window that approves every call (or only `allowTools`), standing in for
 * the runtime's approval gate while a person drives the vendor app by hand;
 * `DELETE /:connectorId/turn` closes it.
 */
export function createLocalConnectorRoutes(
  deps: {
    registry?: LocalConnectorRegistry;
    turns?: TurnWindowStore;
    isEnabled?: (c: Context) => Promise<boolean>;
  } = {},
): Hono {
  const registry = deps.registry ?? localWebConnectors;
  const turns = deps.turns ?? webClientTurnWindows;
  const isEnabled = deps.isEnabled ?? flagOn;
  const app = new Hono();
  const unknown = (c: Context) =>
    c.json({ error: "No local connector has this id. List them with GET." }, 404);

  app.use("*", async (c, next) => {
    if (await isEnabled(c)) return next();
    return c.json(
      {
        error:
          "Claude web and ChatGPT web are off for this Inspector. Turn on web-clients-enabled, then register again.",
      },
      404,
    );
  });
  app.get("/", (c) => c.json({ connectors: registry.list() }));
  app.post("/", async (c) => {
    const parsed = registration.safeParse(await readJson(c));
    if (!parsed.success)
      return c.json(
        { error: "Send { upstreamUrl, headers?, serverId? } with an http or https URL." },
        400,
      );
    const connector = registry.register(parsed.data, await flagSubject(c));
    return c.json(
      {
        connectorId: connector.connectorId,
        path: webConnectorPath(connector.connectorId),
      },
      201,
    );
  });
  app.delete("/:connectorId", (c) => {
    const connectorId = c.req.param("connectorId");
    // The runtime opens its turns in the same store, so only a connector
    // registered here has its turn closed here.
    if (!registry.has(connectorId)) return unknown(c);
    const window = turns.active(connectorId);
    if (window) turns.close(window.turnId);
    return registry.remove(connectorId) ? c.body(null, 204) : unknown(c);
  });
  app.post("/:connectorId/turn", async (c) => {
    const connectorId = c.req.param("connectorId");
    if (!registry.has(connectorId)) return unknown(c);
    // Never read as `{}`: a cut-off `allowTools` would open a turn that
    // allows every tool.
    const parsed = turnRequest.safeParse(await readJson(c));
    if (!parsed.success)
      return c.json({ error: "Send { allowTools?: string[] }." }, 400);
    const allowTools = parsed.data.allowTools;
    try {
      const window = turns.open({
        connectorId,
        runId: `local-${Date.now()}`,
        approve: async (call) =>
          !allowTools || allowTools.includes(call.toolName)
            ? { allow: true }
            : {
                allow: false,
                reason: `The local turn allows only ${allowTools.join(", ")}, so ${call.toolName} was not sent. Open a turn that allows it, then send the prompt again.`,
              },
      });
      return c.json({ turnId: window.turnId }, 201);
    } catch (error) {
      if (error instanceof TurnWindowConflictError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.delete("/:connectorId/turn", (c) => {
    const connectorId = c.req.param("connectorId");
    if (!registry.has(connectorId)) return unknown(c);
    const window = turns.active(connectorId);
    if (window) turns.close(window.turnId);
    return c.body(null, 204);
  });
  return app;
}

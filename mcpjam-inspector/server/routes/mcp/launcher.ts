import { Hono, type Context } from "hono";
import {
  parseLauncherAttachRequest,
  type LauncherAttachResult,
  type LauncherDecision,
  type LauncherTabPoll,
} from "@/shared/launcher-attach.js";
import {
  LauncherAttachRegistry,
  type LauncherRegistryError,
} from "../../services/launcher-attach/registry.js";

const SWEEP_INTERVAL_MS = 2_000;

const ERROR_STATUS: Record<LauncherRegistryError, 404 | 409 | 429> = {
  unknown_attach: 404,
  not_assigned: 409,
  too_many_requests: 429,
};

const ERROR_MESSAGE: Record<LauncherRegistryError, string> = {
  unknown_attach: "No attach request with this id. Restart the dev command to attach again.",
  not_assigned: "Another tab is handling this attach request.",
  too_many_requests:
    "Too many dev commands are attached to this MCPJam. Quit one, then try again.",
};

/**
 * Routes for attaching a dev command's server to an open tab. See
 * `shared/launcher-attach.ts` for the flow.
 */
export function createLauncherRoutes(registry: LauncherAttachRegistry) {
  const routes = new Hono();
  const fail = (c: Context, error: LauncherRegistryError) =>
    c.json({ code: error, message: ERROR_MESSAGE[error] }, ERROR_STATUS[error]);

  routes.post("/attach", async (c) => {
    const parsed = parseLauncherAttachRequest(await readJson(c.req.raw));
    if (!parsed.ok) {
      return c.json({ code: "invalid_request", message: parsed.error }, 400);
    }
    const result = registry.attach(parsed.request);
    if (!result.ok) return fail(c, result.error);
    return c.json(result.state, 202);
  });

  routes.get("/attach/:attachId", (c) => {
    const state = registry.state(c.req.param("attachId"));
    return state ? c.json(state) : fail(c, "unknown_attach");
  });

  routes.delete("/attach/:attachId", (c) => {
    return registry.release(c.req.param("attachId"))
      ? c.json({ released: true })
      : fail(c, "unknown_attach");
  });

  // Whether a tab still has to undo what this attach added. A dev command
  // about to stop MCPJam waits for `done`, or the entry would stay saved.
  routes.get("/attach/:attachId/release", (c) =>
    c.json(registry.releaseState(c.req.param("attachId"))),
  );

  routes.post("/attach/:attachId/claim", async (c) => {
    const tabId = readTabId(await readJson(c.req.raw));
    if (!tabId) return c.json({ code: "invalid_request", message: "tabId is required." }, 400);
    const error = registry.claim(c.req.param("attachId"), tabId);
    return error ? fail(c, error) : c.json({ claimed: true });
  });

  routes.post("/attach/:attachId/route", async (c) => {
    const body = await readJson(c.req.raw);
    const tabId = readTabId(body);
    const projectId = readString(body, "projectId");
    if (!tabId || !projectId) {
      return c.json(
        { code: "invalid_request", message: "tabId and projectId are required." },
        400,
      );
    }
    const error = registry.route(c.req.param("attachId"), tabId, projectId);
    return error ? fail(c, error) : c.json({ routed: true });
  });

  routes.post("/attach/:attachId/result", async (c) => {
    const result = parseResult(await readJson(c.req.raw));
    if (!result) {
      return c.json({ code: "invalid_request", message: "The result is not valid." }, 400);
    }
    const error = registry.result(c.req.param("attachId"), result);
    return error ? fail(c, error) : c.json({ recorded: true });
  });

  routes.post("/attach/:attachId/released", async (c) => {
    const tabId = readTabId(await readJson(c.req.raw));
    if (!tabId) return c.json({ code: "invalid_request", message: "tabId is required." }, 400);
    const error = registry.released(c.req.param("attachId"), tabId);
    return error ? fail(c, error) : c.json({ recorded: true });
  });

  routes.post("/tabs/:tabId/poll", async (c) => {
    const poll = parsePoll(await readJson(c.req.raw));
    if (!poll) {
      return c.json({ code: "invalid_request", message: "The poll is not valid." }, 400);
    }
    return c.json(registry.poll(c.req.param("tabId"), poll));
  });

  routes.post("/tabs/:tabId/close", (c) => {
    registry.closeTab(c.req.param("tabId"));
    return c.json({ closed: true });
  });

  return routes;
}

export const launcherAttachRegistry = new LauncherAttachRegistry();
setInterval(() => launcherAttachRegistry.sweep(), SWEEP_INTERVAL_MS).unref();

export default createLauncherRoutes(launcherAttachRegistry);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    // An empty or malformed body is reported by each route's own validation.
    return undefined;
  }
}

function readString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTabId(body: unknown): string | undefined {
  return readString(body, "tabId");
}

function parsePoll(body: unknown): LauncherTabPoll | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { focusedAt, signedIn, project } = body as Record<string, unknown>;
  if (typeof focusedAt !== "number" || typeof signedIn !== "boolean") {
    return undefined;
  }
  if (project === null || project === undefined) {
    return { focusedAt, signedIn, project: null };
  }
  const id = readString(project, "id");
  const name = readString(project, "name");
  if (!id || !name) return undefined;
  return { focusedAt, signedIn, project: { id, name } };
}

function parseDecision(value: unknown): LauncherDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const projectId = readString(value, "projectId");
  const projectName = readString(value, "projectName");
  const serverName = readString(value, "serverName");
  const createdByAttach = (value as Record<string, unknown>).createdByAttach;
  if (!projectId || !projectName || !serverName) return undefined;
  if (typeof createdByAttach !== "boolean") return undefined;
  return { projectId, projectName, serverName, createdByAttach };
}

function parseResult(body: unknown): LauncherAttachResult | undefined {
  const tabId = readTabId(body);
  if (!tabId) return undefined;
  const record = body as Record<string, unknown>;
  const decision = parseDecision(record.decision);
  if (record.outcome === "saved" || record.outcome === "connected") {
    return decision ? { tabId, outcome: record.outcome, decision } : undefined;
  }
  if (record.outcome === "failed") {
    const message = readString(body, "message");
    if (!message) return undefined;
    return { tabId, outcome: "failed", message, ...(decision ? { decision } : {}) };
  }
  return undefined;
}

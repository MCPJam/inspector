/**
 * The mock mark on `GET /projects/:projectId/servers`. The backend's server
 * list does not say which rows are mocks, and a mock is an ordinary-looking
 * HTTP server row, so a middleware on that route adds the mark to the answer
 * from the project's mock list.
 */
import type { MiddlewareHandler } from "hono";
import { makeFunctionReference } from "convex/server";
import { logger } from "../../utils/logger.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { createConvexClient } from "./convex-client.js";

const listMocks = makeFunctionReference<"query">("mockServers:listMocks");

type MockSummary = { mockId: string; baseServerId: string | null; headVersion: number };

/** Adds `mock: { baseServerId, headVersion }` to each listed server that is a mock. */
export const markMockServers: MiddlewareHandler = async (c, next) => {
  await next();
  // The backend's mock reads are for signed-in callers; a guest lists without marks.
  if (c.res.status !== 200 || c.get("guestId")) return;
  try {
    const page: { items?: Array<{ id?: unknown }> } = await c.res.clone().json();
    const client = createConvexClient(await getConvexBearerForRequest(c));
    const rows: MockSummary[] = await client.query(listMocks, { projectId: c.req.param("projectId") });
    const mocks = new Map(rows.map((row) => [row.mockId, row]));
    const items = page.items?.map((item) => {
      const mock = mocks.get(String(item.id));
      return mock ? { ...item, mock: { baseServerId: mock.baseServerId, headVersion: mock.headVersion } } : item;
    });
    if (items && mocks.size > 0) c.res = new Response(JSON.stringify({ ...page, items }), c.res);
  } catch (error) {
    // The list already answered; losing the marks must not lose it.
    logger.warn("[v1.mock-servers] mock marks not added to the server list", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

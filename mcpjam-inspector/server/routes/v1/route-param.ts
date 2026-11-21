import type { Context } from "hono";

/**
 * A path parameter the matched route declares.
 *
 * Handlers registered on more than one path (a canonical route and its
 * deprecated alias) take a plain `Context`, so Hono cannot infer the path's
 * params and types every read as `string | undefined`. The router only
 * dispatches such a handler on paths that declare the segment, so a missing
 * one is a registration bug, not a bad request.
 */
export function routeParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) {
    throw new Error(`Route does not declare the :${name} parameter`);
  }
  return value;
}

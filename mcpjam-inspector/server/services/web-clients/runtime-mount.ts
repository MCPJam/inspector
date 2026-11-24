/**
 * The web client runtime's place in the server: the account routes, and the
 * environment hosted turns build their account, connectors and browser from.
 * Both server entries (`index.ts`, `app.ts`) call this one function.
 *
 * A local Inspector gets no environment here: its runs need a public URL for
 * the vendor to reach and a browser profile source, which only the local
 * tracer provides today.
 */
import type { Hono } from "hono";
import { createDefaultWebAccountRoutes } from "./account-routes-default.js";
import { createHostedWebClientEnvironmentFactory } from "./hosted-web-client-runtime.js";
import { setWebClientEnvironment } from "./web-client-environment.js";

export function mountWebClientRuntime(app: Hono, options: { hosted: boolean }): void {
  app.route("/api/web-clients", createDefaultWebAccountRoutes());
  if (options.hosted) setWebClientEnvironment(createHostedWebClientEnvironmentFactory());
}

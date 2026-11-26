import type { MiddlewareHandler } from "hono";
import { CANIUSE_LANDING_HOSTS, SCORE_LANDING_HOSTS } from "../config.js";

// Only the vanity domains' root URLs redirect. Deep links reach the SPA.
export const vanityDomainLandingMiddleware: MiddlewareHandler = (c, next) => {
  if (c.req.path !== "/") return next();

  const host = (c.req.header("Host") ?? "").toLowerCase().split(":")[0];
  if (CANIUSE_LANDING_HOSTS.has(host)) {
    const { search } = new URL(c.req.url);
    return c.redirect(`/compare${search}`, 302);
  }
  if (SCORE_LANDING_HOSTS.has(host)) {
    return c.redirect("/embed/score", 302);
  }
  return next();
};

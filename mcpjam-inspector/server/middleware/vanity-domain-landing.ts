import type { MiddlewareHandler } from "hono";
import { CANIUSE_LANDING_HOSTS, SCORE_LANDING_HOSTS } from "../config.js";

// Exact vanity paths only. Canonical capability links reach the SPA.
const CANIUSE_REDIRECTS = new Map([
  ["/", "/compare"],
  ["/embed/host-compare", "/compare"],
  ["/embed/host-compare/", "/compare"],
  ["/capabilities", "/capabilities/event-delivery"],
  ["/events", "/capabilities/event-delivery"],
  ["/apps", "/capabilities/ui-extension"],
  ["/tasks", "/capabilities/mcp-tasks"],
  ["/skills", "/capabilities/skills-extension"],
  ["/protocol-versions", "/capabilities/supported-protocol-versions"],
  ["/elicitation", "/capabilities/elicitation"],
  ["/sampling", "/capabilities/sampling"],
  ["/roots", "/capabilities/roots"],
]);

export const vanityDomainLandingMiddleware: MiddlewareHandler = async (
  c,
  next,
) => {
  const path = c.req.path;
  const host = (c.req.header("Host") ?? "").toLowerCase().split(":")[0];
  if (CANIUSE_LANDING_HOSTS.has(host)) {
    const destination = CANIUSE_REDIRECTS.get(path);
    if (destination) {
      const { search } = new URL(c.req.url);
      return c.redirect(`${destination}${search}`, 302);
    }
  }
  if (path === "/" && SCORE_LANDING_HOSTS.has(host)) {
    return c.redirect("/embed/score", 302);
  }
  return next();
};

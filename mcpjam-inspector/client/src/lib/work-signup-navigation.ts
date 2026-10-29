import { stripProjectFromPath } from "./project-route";

/** Explicit project, invitation, checkout and OAuth returns keep their destination. */
export function canRouteWorkSignup(entry: string, current: string): boolean {
  const generic = new Set(["/", "/home", "/servers"]);
  if (!generic.has(entry)) return false;
  return generic.has(stripProjectFromPath(current));
}

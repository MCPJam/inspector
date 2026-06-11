import { HOSTED_MODE } from "@/lib/config";

export function isHostedMode(): boolean {
  return HOSTED_MODE;
}

export function ensureLocalMode(message: string): void {
  if (HOSTED_MODE) {
    throw new Error(message);
  }
}

export async function runByMode<T>(options: {
  hosted: () => Promise<T>;
  local: () => Promise<T>;
  /**
   * Session-scoped override: run the hosted branch even on local builds.
   * Set by surfaces whose servers are Convex-resolved on every platform
   * (the published chatbox runtime) — the local /api/mcp branch can't
   * connect those servers. See `useWebManagedServers`.
   */
  forceHosted?: boolean;
}): Promise<T> {
  return HOSTED_MODE || options.forceHosted
    ? options.hosted()
    : options.local();
}

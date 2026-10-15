import { isLoopbackOAuthUrl } from "@mcpjam/sdk/browser";
import { useWorkosAuthUnavailableStore } from "@/stores/workos-auth-unavailable-store";

export type WorkosAuthStartResult = "started" | "blocked";

export function isUnsupportedWorkosAuthOrigin(origin: string): boolean {
  return (
    origin !== "null" &&
    new URL(origin).protocol === "http:" &&
    !isLoopbackOAuthUrl(origin)
  );
}

export async function startWorkosAuth(
  start: () => void | Promise<void>,
  origin = globalThis.location.origin,
): Promise<WorkosAuthStartResult> {
  // WorkOS production callbacks require HTTPS outside loopback, even if a
  // browser exposes Web Crypto on an explicitly trusted HTTP origin.
  if (isUnsupportedWorkosAuthOrigin(origin)) {
    useWorkosAuthUnavailableStore.getState().show();
    return "blocked";
  }
  await start();
  return "started";
}

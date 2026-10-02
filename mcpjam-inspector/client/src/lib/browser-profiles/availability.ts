import { useEffect, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";

/**
 * Whether this server can save and load browser profile archives
 * (`GET /api/web/browser-profiles/availability`). Both need the inspector
 * service credential, which local and desktop installs do not hold; listing,
 * choosing and deleting profiles work either way.
 *
 * A hosted server always can, so hosted never asks. Anything short of a clear
 * "no" reads as "yes", and only a clear answer is remembered: an older server
 * without the route, a signed-out caller or a failed request leave the UI as
 * it was, and ask again next time.
 */
let remembered: Promise<boolean> | null = null;

/** The server's clear answer, or null when it gave none. */
async function askServer(): Promise<boolean | null> {
  try {
    const response = await authFetch("/api/web/browser-profiles/availability");
    if (!response.ok) return null;
    const body = (await response.json()) as { archives?: unknown } | null;
    return typeof body?.archives === "boolean" ? body.archives : null;
  } catch {
    return null;
  }
}

export function getBrowserProfileArchivesAvailable(): Promise<boolean> {
  if (HOSTED_MODE) return Promise.resolve(true);
  if (remembered) return remembered;
  const asking: Promise<boolean> = askServer().then((answer) => {
    if (answer === null) {
      if (remembered === asking) remembered = null;
      return true;
    }
    return answer;
  });
  remembered = asking;
  return asking;
}

/** `false` once this server has said it cannot save or load profiles. */
export function useBrowserProfileArchivesAvailable(): boolean {
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let live = true;
    void getBrowserProfileArchivesAvailable().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

export function resetBrowserProfileAvailabilityForTests(): void {
  remembered = null;
}

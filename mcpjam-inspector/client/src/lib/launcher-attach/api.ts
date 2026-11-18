import { authFetch } from "@/lib/session-token";
import type {
  LauncherAttachResult,
  LauncherPollResponse,
  LauncherTabPoll,
} from "@/shared/launcher-attach";

const BASE = "/api/mcp/launcher";

async function post(path: string, body?: unknown, init?: RequestInit) {
  return authFetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

export async function pollLauncherTasks(
  tabId: string,
  poll: LauncherTabPoll,
): Promise<LauncherPollResponse | null> {
  const res = await post(`/tabs/${encodeURIComponent(tabId)}/poll`, poll);
  return res.ok ? ((await res.json()) as LauncherPollResponse) : null;
}

/** True when this tab now owns the request. */
export async function claimLauncherAttach(
  attachId: string,
  tabId: string,
): Promise<boolean> {
  const res = await post(`/attach/${encodeURIComponent(attachId)}/claim`, {
    tabId,
  });
  return res.ok;
}

export async function routeLauncherAttach(
  attachId: string,
  tabId: string,
  projectId: string,
): Promise<void> {
  await post(`/attach/${encodeURIComponent(attachId)}/route`, {
    tabId,
    projectId,
  });
}

/**
 * True when MCPJam took the report. A refusal means it no longer knows the
 * request (the dev command quit, or MCPJam restarted); a network failure is
 * reported as refused too, since either way nothing will act on the entry.
 */
export async function reportLauncherAttach(
  attachId: string,
  result: LauncherAttachResult,
): Promise<boolean> {
  try {
    const res = await post(`/attach/${encodeURIComponent(attachId)}/result`, result);
    return res.ok;
  } catch (error) {
    console.warn("[launcher-attach] Could not report to MCPJam", error);
    return false;
  }
}

export async function reportLauncherReleased(
  attachId: string,
  tabId: string,
): Promise<void> {
  await post(`/attach/${encodeURIComponent(attachId)}/released`, { tabId });
}

/** Sent as the page unloads, so another tab takes over without waiting. */
export function closeLauncherTab(tabId: string): void {
  void post(`/tabs/${encodeURIComponent(tabId)}/close`, undefined, {
    keepalive: true,
  }).catch(() => {
    // The tab is going away; its registration expires on its own.
  });
}

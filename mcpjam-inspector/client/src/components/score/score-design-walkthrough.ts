/**
 * Local-only path through the score landing, so design review does not
 * wait on a guest Convex project or a 15-minute scan.
 *
 * Triggered in DEV by `?preview=1`, the dummy host, or a missing project id.
 */
export const SCORE_DEMO_SERVER_URL = "https://demo.mcpjam.com/mcp";

export const SCORE_PREVIEW_RESULT_TOKEN = "preview";

const WALKTHROUGH_PREPARING_MS = 280;
const WALKTHROUGH_RUNNING_MS = 720;

export function isScoreDemoServerUrl(serverUrl: string): boolean {
  try {
    return new URL(serverUrl).hostname === "demo.mcpjam.com";
  } catch {
    return false;
  }
}

export function isScorePreviewQuery(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("preview") === "1";
}

export function isScoreDesignWalkthrough(
  serverUrl: string,
  projectId: string | null,
): boolean {
  if (!import.meta.env.DEV) return false;
  return (
    isScorePreviewQuery() ||
    isScoreDemoServerUrl(serverUrl) ||
    projectId == null
  );
}

export async function playScoreDesignWalkthrough(advance: {
  preparing: () => void;
  running: () => void;
  done: () => void;
}): Promise<void> {
  advance.preparing();
  await wait(WALKTHROUGH_PREPARING_MS);
  advance.running();
  await wait(WALKTHROUGH_RUNNING_MS);
  advance.done();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

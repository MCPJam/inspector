import { createHash } from "node:crypto";
import { operationalError } from "./errors.js";
import { delay } from "./launch.js";

/**
 * The server a dev command attaches to an open MCPJam tab. Mirrors
 * `LauncherServer` in the Inspector's `shared/launcher-attach.ts`, which the
 * local MCPJam server validates.
 */
export interface InspectorAttachServer {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  useOAuth?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface InspectorAttachState {
  attachId: string;
  status: "pending" | "claimed" | "connected" | "failed";
  serverName: string;
  projectName?: string;
  message?: string;
}

const ATTACH_TIMEOUT_MS = 5_000;

/**
 * Stable for one process, port and server, so a Vite restart in the same
 * process sends the same id and the tab reuses its earlier decision.
 *
 * The server's identity is its name and what it points at (URL, or command
 * and arguments), not the name alone: a changed URL is a different server,
 * and two launches in one process that share a name but not a URL must not
 * overwrite each other's request. Headers and environment are not part of
 * it; editing them is the same server.
 */
export function inspectorAttachId(
  pid: number,
  port: number,
  server: InspectorAttachServer,
): string {
  const target =
    server.url !== undefined
      ? `url:${server.url}`
      : `command:${JSON.stringify([server.command, ...(server.args ?? [])])}`;
  return createHash("sha256")
    .update(`${pid}\0${port}\0${server.name}\0${target}`)
    .digest("hex")
    .slice(0, 24);
}

function headers(token: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-MCP-Session-Auth": `Bearer ${token}` } : {}),
  };
}

/**
 * Hands the server to the local MCPJam, which passes it to an open tab. It
 * resolves once the request is registered, never on a choice in the tab.
 */
export async function requestInspectorAttach(
  baseUrl: string,
  token: string | undefined,
  request: { attachId: string; server: InspectorAttachServer; pid?: number },
): Promise<InspectorAttachState> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/mcp/launcher/attach`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS),
    });
  } catch (error) {
    throw operationalError(
      `Could not reach MCPJam at ${baseUrl} to add ${request.server.name}.`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const body = await readBody(response);
  if (response.status === 404) {
    throw operationalError(
      `The MCPJam at ${baseUrl} is too old to add ${request.server.name}. Update @mcpjam/inspector and restart it.`,
    );
  }
  if (!response.ok || !body) {
    throw operationalError(
      `MCPJam did not add ${request.server.name}: ${body?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return body;
}

/** The dev command quit: the tab undoes what this attach added. */
export async function releaseInspectorAttach(
  baseUrl: string,
  token: string | undefined,
  attachId: string,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/mcp/launcher/attach/${encodeURIComponent(attachId)}`, {
      method: "DELETE",
      headers: headers(token),
      signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS),
    });
  } catch {
    // MCPJam already stopped, or will notice the dev command's exit itself.
  }
}

async function readBody(
  response: Response,
): Promise<(InspectorAttachState & { message?: string }) | undefined> {
  try {
    return (await response.json()) as InspectorAttachState & { message?: string };
  } catch {
    // A non-JSON answer is reported by its status instead.
    return undefined;
  }
}

async function releaseIsPending(
  baseUrl: string,
  token: string | undefined,
  attachId: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${baseUrl}/api/mcp/launcher/attach/${encodeURIComponent(attachId)}/release`,
      { headers: headers(token), signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS) },
    );
    // An MCPJam without this route cannot report, so there is nothing to wait for.
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === "pending";
  } catch {
    // MCPJam is gone or unreachable: no tab will handle the release now.
    return false;
  }
}

/**
 * Waits, up to `timeoutMs`, until a tab has undone each attach. Releasing only
 * queues the undo; a tab applies it on its next poll. A caller about to stop
 * MCPJam waits here, or the server this launch added stays saved in the project.
 */
export async function waitForInspectorReleases(
  baseUrl: string,
  token: string | undefined,
  attachIds: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let pending = attachIds;
  while (pending.length > 0 && Date.now() < deadline) {
    const states = await Promise.all(
      pending.map((id) => releaseIsPending(baseUrl, token, id)),
    );
    pending = pending.filter((_, index) => states[index]);
    if (pending.length > 0) await delay(250);
  }
}

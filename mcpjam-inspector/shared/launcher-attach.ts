/**
 * Wire types for attaching a dev command's MCP server to an open MCPJam tab.
 *
 * A dev command (through `launchInspector()` or the Vite plugin) posts its
 * server to the local MCPJam server. Saving a server to a project needs the
 * signed-in user's own credentials, which only a browser tab holds, so the
 * local server hands each request to exactly one open tab. That tab picks the
 * project, saves and connects the server, and reports back.
 *
 * Routes live under `/api/mcp/launcher`, so they share the session-token check
 * and are not mounted in hosted mode.
 */

/** The server a dev command attaches: HTTP (`url`) or stdio (`command`). */
export interface LauncherServer {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  useOAuth?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** `POST /api/mcp/launcher/attach` body. */
export interface LauncherAttachRequest {
  /**
   * Stable for one dev command process and server, so a Vite restart in the
   * same process sends the same id and reuses the earlier decision.
   */
  attachId: string;
  server: LauncherServer;
  /** The dev command's process; the request is released when it exits. */
  pid?: number;
}

export type LauncherAttachStatus =
  /** Waiting for a signed-in tab to take it. */
  | "pending"
  /** A tab took it and may be asking the developer to choose a project. */
  | "claimed"
  | "connected"
  | "failed";

/** `GET /api/mcp/launcher/attach/:attachId` and the attach response. */
export interface LauncherAttachState {
  attachId: string;
  status: LauncherAttachStatus;
  serverName: string;
  projectName?: string;
  message?: string;
}

/** A project as an open tab shows it. */
export interface LauncherTabProject {
  id: string;
  name: string;
}

/** What a tab reports each time it polls. */
export interface LauncherTabPoll {
  /** Last time this tab gained focus or became visible (epoch ms). */
  focusedAt: number;
  signedIn: boolean;
  project: LauncherTabProject | null;
}

/** Where a server was saved, kept so a restart reuses it and quitting undoes it. */
export interface LauncherDecision {
  projectId: string;
  projectName: string;
  serverName: string;
  /** False when the project already had this server saved before the attach. */
  createdByAttach: boolean;
}

export interface LauncherAttachTask {
  kind: "attach";
  attachId: string;
  server: LauncherServer;
  /** Set when an earlier attach from the same process already decided. */
  decision?: LauncherDecision;
  /** Set when the developer picked this project in another tab. */
  targetProjectId?: string;
  /** Distinct projects shown by open signed-in tabs, this tab's included. */
  openProjects: LauncherTabProject[];
}

export interface LauncherReleaseTask {
  kind: "release";
  attachId: string;
  server: LauncherServer;
  decision: LauncherDecision;
}

export type LauncherTask = LauncherAttachTask | LauncherReleaseTask;

/** `POST /api/mcp/launcher/tabs/:tabId/poll` response. */
export interface LauncherPollResponse {
  tasks: LauncherTask[];
  /** Attach requests withdrawn before this tab finished them. */
  cancelledAttachIds: string[];
  /**
   * Requests waiting because no signed-in tab is open. Only sent to tabs that
   * are not signed in, so they can ask the developer to sign in.
   */
  waitingForSignIn: Array<{ attachId: string; serverName: string }>;
}

/**
 * `POST /api/mcp/launcher/attach/:attachId/result` body.
 *
 * A tab reports `saved` the moment the entry is in the project, before it
 * connects (which can take a minute or wait on stdio approval). From then on
 * the registry knows the attach created the entry, whatever happens next: a
 * release, a reset after the tab reloads, or a restart.
 */
export type LauncherAttachResult =
  | {
      tabId: string;
      outcome: "saved";
      decision: LauncherDecision;
    }
  | {
      tabId: string;
      outcome: "connected";
      decision: LauncherDecision;
    }
  | {
      tabId: string;
      outcome: "failed";
      message: string;
      /** Set when the entry was saved even though connecting failed. */
      decision?: LauncherDecision;
    };

/** `GET /api/mcp/launcher/attach/:attachId/release` response. */
export interface LauncherReleaseState {
  /** `pending` until a tab has undone what the attach added. */
  status: "pending" | "done";
}

/** True when the server is a stdio command rather than an HTTP URL. */
export function isStdioLauncherServer(server: LauncherServer): boolean {
  return typeof server.command === "string" && server.command.length > 0;
}

/**
 * Validates an attach request body. Returns an error message for the dev
 * command, or the parsed request.
 */
export function parseLauncherAttachRequest(
  body: unknown,
): { ok: true; request: LauncherAttachRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "The attach request body must be a JSON object." };
  }
  const { attachId, server, pid } = body as Record<string, unknown>;
  if (typeof attachId !== "string" || !attachId.trim()) {
    return { ok: false, error: "attachId is required." };
  }
  if (!server || typeof server !== "object") {
    return { ok: false, error: "server is required." };
  }
  const s = server as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name.trim()) {
    return { ok: false, error: "server.name is required." };
  }
  const hasUrl = typeof s.url === "string" && s.url.length > 0;
  const hasCommand = typeof s.command === "string" && s.command.length > 0;
  if (hasUrl === hasCommand) {
    return {
      ok: false,
      error: "Set exactly one of server.url (HTTP) or server.command (stdio).",
    };
  }
  if (hasUrl) {
    try {
      const parsed = new URL(s.url as string);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "server.url must be an http or https URL." };
      }
    } catch {
      return { ok: false, error: "server.url is not a valid URL." };
    }
  }
  if (s.args !== undefined && !isStringArray(s.args)) {
    return { ok: false, error: "server.args must be an array of strings." };
  }
  if (s.headers !== undefined && !isStringRecord(s.headers)) {
    return { ok: false, error: "server.headers must map names to strings." };
  }
  if (s.env !== undefined && !isStringRecord(s.env)) {
    return { ok: false, error: "server.env must map names to strings." };
  }
  if (pid !== undefined && (!Number.isInteger(pid) || (pid as number) <= 0)) {
    return { ok: false, error: "pid must be a positive integer." };
  }
  const request: LauncherAttachRequest = {
    attachId: attachId.trim(),
    server: {
      name: s.name.trim(),
      ...(hasUrl ? { url: s.url as string } : { command: s.command as string }),
      ...(s.args !== undefined ? { args: s.args as string[] } : {}),
      ...(s.headers !== undefined
        ? { headers: s.headers as Record<string, string> }
        : {}),
      ...(s.env !== undefined ? { env: s.env as Record<string, string> } : {}),
      ...(s.useOAuth === true ? { useOAuth: true } : {}),
    },
    ...(pid !== undefined ? { pid: pid as number } : {}),
  };
  return { ok: true, request };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

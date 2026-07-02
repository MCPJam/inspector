/**
 * Browser side of the computer terminal WebSocket bridge. Speaks the protocol
 * served by the inspector server (`server/routes/web/computer-terminal.ts`):
 *
 *   client → server  binary frame        raw stdin bytes
 *   client → server  text {type:"resize",cols,rows} | {type:"ping"}
 *   server → client  binary frame        raw PTY output
 *   server → client  text {type:"ready",sessionId} | {type:"exit"}
 *                    | {type:"error",message} | {type:"pong"}
 *
 * Auth is the Convex-minted terminal token in the query string (the
 * `/api/web/*` routes are not session-gated; the token IS the auth). Kept
 * free of xterm so the protocol is unit-testable with a fake WebSocket.
 */

export type TerminalEvent =
  | { type: "ready"; sessionId: string }
  | { type: "exit" }
  | { type: "error"; message: string };

export interface TerminalConnection {
  sendInput(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Liveness ping; server replies with pong (ignored). */
  ping(): void;
  close(): void;
}

export interface OpenTerminalOptions {
  token: string;
  cols: number;
  rows: number;
  onOutput: (data: Uint8Array) => void;
  onEvent: (event: TerminalEvent) => void;
  onOpen?: () => void;
  onClose: (code: number, reason: string) => void;
  /** Origin override (defaults to the current page origin); mainly for tests. */
  baseUrl?: string;
  /** Starting working directory for the PTY (e.g. the harness session workdir).
   *  Applied server-side at PTY creation; falls back to home if it can't be set. */
  cwd?: string;
  /** WebSocket factory override for tests. */
  wsFactory?: (url: string) => WebSocket;
}

/**
 * Convert a data-plane HTTP(S) origin into the `ws(s)://host` base expected
 * by `buildTerminalWsUrl`. Used when this inspector delegates to a remote
 * data plane (see GET /api/web/computers/config); the terminal token in the
 * query string is the auth, so a cross-origin socket needs nothing else.
 */
export function toTerminalWsBase(httpOrigin: string): string | undefined {
  try {
    const url = new URL(httpOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Build the `http(s)://…/api/web/computers/upload` URL. The upload MUST hit the
 * same data plane as the terminal WebSocket (the sandbox lives there), so when a
 * remote `ws(s)://` base is set we convert it back to `http(s)://`; otherwise we
 * return a page-origin-relative path.
 */
export function buildComputerUploadUrl(args?: { baseUrl?: string }): string {
  const path = "/api/web/computers/upload";
  const base = args?.baseUrl;
  if (!base) return path;
  // `baseUrl` is the ws(s):// terminal base; swap the scheme for fetch.
  const origin = base
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  return `${origin}${path}`;
}

export interface UploadedComputerFile {
  name: string;
  path: string;
  bytes: number;
}

/**
 * POST files to the user's project computer (drag-and-drop from the Shell). The
 * `token` is a fresh Convex-minted terminal token (the same one the WS uses);
 * auth is `Authorization: Bearer <token>` — headers stay out of access/proxy
 * logs, query strings don't. `dir` targets a destination directory (the
 * Shell's cwd — i.e. the harness workdir) so uploads land where the user is
 * working; the server confines it under the box home and falls back to a
 * default bucket when absent/invalid. Resolves to the written files (with
 * their absolute sandbox paths) or throws with a server-supplied message.
 */
export async function uploadFilesToComputer(args: {
  token: string;
  files: File[];
  baseUrl?: string;
  dir?: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedComputerFile[]> {
  const params = new URLSearchParams();
  if (args.dir) params.set("dir", args.dir);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const url = `${buildComputerUploadUrl({ baseUrl: args.baseUrl })}${query}`;
  const form = new FormData();
  for (const file of args.files) form.append("files", file);

  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${args.token}` },
  });
  let body: { ok?: boolean; files?: UploadedComputerFile[]; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON (e.g. a proxy error page) — fall through to the status check.
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `Upload failed (${res.status}).`);
  }
  return body.files ?? [];
}

/** Build the `ws(s)://…/api/web/computers/terminal?…` URL from page origin. */
export function buildTerminalWsUrl(args: {
  token: string;
  cols: number;
  rows: number;
  baseUrl?: string;
  cwd?: string;
}): string {
  const origin =
    args.baseUrl ??
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
      window.location.host
    }`;
  const params = new URLSearchParams({
    token: args.token,
    cols: String(args.cols),
    rows: String(args.rows),
  });
  if (args.cwd) params.set("cwd", args.cwd);
  return `${origin}/api/web/computers/terminal?${params.toString()}`;
}

export function openTerminalConnection(
  opts: OpenTerminalOptions
): TerminalConnection {
  const url = buildTerminalWsUrl(opts);
  const ws = (opts.wsFactory ?? ((u: string) => new WebSocket(u)))(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => opts.onOpen?.();

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === "string") {
      let message: { type?: string; sessionId?: string; message?: string };
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === "ready") {
        opts.onEvent({
          type: "ready",
          sessionId: String(message.sessionId ?? ""),
        });
      } else if (message.type === "exit") {
        opts.onEvent({ type: "exit" });
      } else if (message.type === "error") {
        opts.onEvent({
          type: "error",
          message: String(message.message ?? "Terminal error"),
        });
      }
      // {type:"pong"} and anything unknown is ignored.
      return;
    }
    // Binary PTY output.
    if (data instanceof ArrayBuffer) {
      opts.onOutput(new Uint8Array(data));
    }
  };

  ws.onclose = (event: CloseEvent) =>
    opts.onClose(event.code, event.reason ?? "");
  // Errors are always followed by a close; surface via onClose only.
  ws.onerror = () => {};

  const sendIfOpen = (payload: string | ArrayBufferView) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload as never);
  };

  return {
    sendInput: (bytes) => sendIfOpen(bytes),
    resize: (cols, rows) =>
      sendIfOpen(JSON.stringify({ type: "resize", cols, rows })),
    ping: () => sendIfOpen(JSON.stringify({ type: "ping" })),
    close: () => ws.close(),
  };
}

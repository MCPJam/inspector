import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setProfile } from "./config-store.js";
import {
  AuthError,
  type ApiKeyCredentials,
  type LoginOptions,
  type LoginResult,
  type UserInfo,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const MAX_BODY_BYTES = 8 * 1024; // 8 KiB — bodies are small JSON; anything larger is suspicious.
const STATE_BYTES = 32;
const CALLBACK_PATH = "/callback";

interface CallbackPayload {
  state: string;
  apiKey: string;
  user: UserInfo;
}

/**
 * OAuth-style loopback login. The CLI:
 *   1. binds `http://127.0.0.1:<port>` with a one-shot `/callback` handler,
 *   2. opens `${webBaseUrl}/cli-auth?port=&state=&version=` in a browser,
 *   3. awaits a CSRF-protected POST from the web app containing the freshly
 *      minted `mcpjam_...` API key,
 *   4. persists it via `ConfigStore` (0600) and returns the resolved user.
 *
 * Security posture is captured in the plan file — specifically:
 *   - `state` is exchanged only in the POST body (JSON), compared via
 *     `crypto.timingSafeEqual` on 32-byte buffers after length checks,
 *   - the server binds to `127.0.0.1` only, accepts exactly one terminal
 *     outcome, enforces `application/json`, caps body size, and closes itself,
 *   - CORS allowlist is the exact `webBaseUrl` — preflight honoured, nothing
 *     else allowed.
 */
export async function loginWithBrowser(
  options: LoginOptions,
): Promise<LoginResult> {
  const profile = options.profile ?? "default";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const displayMode = options.displayMode ?? "browser";
  const webOrigin = new URL(options.webBaseUrl).origin;

  const stateBuf = randomBytes(STATE_BYTES);
  const state = stateBuf.toString("base64url");

  return await new Promise<LoginResult>((resolve, reject) => {
    let resolved = false;
    let timer: NodeJS.Timeout | undefined;

    const server = createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        console.error("mcpjam loopback handler error:", err);
        respondJson(res, 500, { error: "Internal loopback error." });
      });
    });

    const finish = (err: AuthError | null, value?: LoginResult) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.unref();
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const origin = req.headers.origin;

      // Preflight
      if (req.method === "OPTIONS" && url.pathname === CALLBACK_PATH) {
        applyCors(res, origin, webOrigin);
        res.statusCode = 204;
        res.end();
        return;
      }

      // Anything other than POST /callback is a 404.
      if (req.method !== "POST" || url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }

      // Hard-reject requests from unexpected origins. Browsers always send
      // `Origin` on cross-origin POSTs, so a missing/mismatched value here is
      // a clear signal something unrelated is poking at the loopback port.
      if (!origin || origin !== webOrigin) {
        applyCors(res, origin, webOrigin);
        respondJson(res, 403, { error: "Origin not allowed." });
        return;
      }

      // Content-Type strictly application/json — browsers can send with
      // arbitrary types, but our web page doesn't.
      const contentType = (req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        applyCors(res, origin, webOrigin);
        respondJson(res, 415, {
          error: "Content-Type must be application/json.",
        });
        return;
      }

      // Read body with an 8 KiB cap.
      let body: Buffer;
      try {
        body = await readBodyWithCap(req, MAX_BODY_BYTES);
      } catch (err: any) {
        applyCors(res, origin, webOrigin);
        respondJson(res, 413, { error: "Request body too large." });
        finish(
          new AuthError(
            "SERVER",
            "Received oversized callback body — aborting login.",
            err,
          ),
        );
        return;
      }

      let payload: CallbackPayload;
      try {
        payload = JSON.parse(body.toString("utf8")) as CallbackPayload;
      } catch {
        applyCors(res, origin, webOrigin);
        respondJson(res, 400, { error: "Invalid JSON." });
        return;
      }

      // `state` is the only CSRF gate: decode and compare constant-time.
      if (
        typeof payload.state !== "string" ||
        !isExpectedState(stateBuf, payload.state)
      ) {
        applyCors(res, origin, webOrigin);
        respondJson(res, 400, { error: "state mismatch." });
        finish(
          new AuthError(
            "STATE_MISMATCH",
            "Received callback with mismatched state. Login aborted.",
          ),
        );
        return;
      }

      if (
        typeof payload.apiKey !== "string" ||
        !payload.apiKey.startsWith("mcpjam_")
      ) {
        applyCors(res, origin, webOrigin);
        respondJson(res, 400, { error: "Missing apiKey." });
        finish(
          new AuthError("SERVER", "Callback payload missing apiKey."),
        );
        return;
      }

      const credentials: ApiKeyCredentials = {
        kind: "apiKey",
        apiKey: payload.apiKey,
        user: normalizeUserInfo(payload.user),
        createdAt: Date.now(),
      };

      try {
        await setProfile(profile, credentials, { makeDefault: true });
      } catch (err: any) {
        applyCors(res, origin, webOrigin);
        respondJson(res, 500, { error: "Failed to persist credentials." });
        finish(
          new AuthError(
            "INVALID_CONFIG",
            `Unable to write credentials file: ${err?.message ?? String(err)}`,
            err,
          ),
        );
        return;
      }

      applyCors(res, origin, webOrigin);
      respondJson(res, 200, { ok: true });
      finish(null, { profile, credentials });
    };

    // Bind on 127.0.0.1 only. `0` picks a free port. IPv6 callers are out of
    // scope — same posture GitHub CLI uses.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address !== "object") {
        finish(new AuthError("SERVER", "Failed to bind loopback port."));
        return;
      }
      const port = address.port;

      timer = setTimeout(() => {
        finish(
          new AuthError(
            "TIMEOUT",
            `Login timed out after ${Math.round(timeoutMs / 1000)}s without a callback.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      const loginUrl = buildLoginUrl(options.webBaseUrl, {
        port,
        state,
        version: options.clientVersion,
        displayMode,
      });

      options.onPrompt?.({ url: loginUrl, port, state });

      if (options.openUrl) {
        Promise.resolve(options.openUrl(loginUrl)).catch((err) => {
          // Opening the browser isn't fatal — the CLI printed the URL too.
          process.emitWarning(
            `mcpjam: failed to open browser automatically: ${err?.message ?? String(err)}`,
          );
        });
      }
    });

    server.on("error", (err) => {
      finish(
        new AuthError(
          "SERVER",
          `Loopback server error: ${err?.message ?? String(err)}`,
          err,
        ),
      );
    });
  });
}

function isExpectedState(expected: Buffer, received: string): boolean {
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(received, "base64url");
  } catch {
    return false;
  }
  if (receivedBuf.length !== expected.length) return false;
  return timingSafeEqual(expected, receivedBuf);
}

function normalizeUserInfo(raw: any): UserInfo {
  if (!raw || typeof raw !== "object") {
    return {
      userId: "",
      email: "",
      name: "",
      workspaceId: null,
      workspaceName: null,
    };
  }
  return {
    userId: typeof raw.userId === "string" ? raw.userId : "",
    email: typeof raw.email === "string" ? raw.email : "",
    name: typeof raw.name === "string" ? raw.name : "",
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : null,
    workspaceName:
      typeof raw.workspaceName === "string" ? raw.workspaceName : null,
    keyPrefix: typeof raw.keyPrefix === "string" ? raw.keyPrefix : undefined,
  };
}

function applyCors(
  res: ServerResponse,
  origin: string | undefined,
  allowed: string,
): void {
  if (origin && origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBodyWithCap(
  req: IncomingMessage,
  cap: number,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error(`Body exceeded ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildLoginUrl(
  base: string,
  params: {
    port: number;
    state: string;
    version?: string;
    displayMode: "browser" | "code";
  },
): string {
  const url = new URL("/cli-auth", base);
  url.searchParams.set("port", String(params.port));
  url.searchParams.set("state", params.state);
  if (params.version) url.searchParams.set("version", params.version);
  if (params.displayMode === "code") url.searchParams.set("display", "code");
  return url.toString();
}

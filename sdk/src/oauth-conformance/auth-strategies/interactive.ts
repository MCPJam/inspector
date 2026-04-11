import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AuthorizationCodeResult } from "../types.js";

export interface InteractiveAuthorizationSession {
  redirectUrl: string;
  authorize(input: {
    authorizationUrl: string;
    expectedState?: string;
    timeoutMs: number;
    openUrl?: (url: string) => Promise<void>;
  }): Promise<AuthorizationCodeResult>;
  stop(): Promise<void>;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getBrowserOpenCommand(
  url: string,
): {
  command: string;
  args: string[];
} {
  switch (process.platform) {
    case "darwin":
      return {
        command: "open",
        args: [url],
      };
    case "win32":
      return {
        command: "cmd",
        args: ["/c", "start", "", url],
      };
    default:
      return {
        command: "xdg-open",
        args: [url],
      };
  }
}

export async function openUrlInBrowser(url: string): Promise<void> {
  const { command, args } = getBrowserOpenCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.removeListener("error", reject);
      child.unref();
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function createInteractiveAuthorizationSession(options?: {
  redirectUrl?: string;
}): Promise<InteractiveAuthorizationSession> {
  let hostname = "127.0.0.1";
  let port = 0;
  let callbackPath = "/callback";

  if (options?.redirectUrl) {
    const parsed = new URL(options.redirectUrl);
    if (parsed.protocol !== "http:") {
      throw new Error(
        "Interactive OAuth conformance runs require an http:// loopback redirect URL",
      );
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error(
        "Interactive OAuth conformance runs require a localhost or 127.0.0.1 redirect URL",
      );
    }
    if (parsed.pathname !== "/callback") {
      throw new Error(
        "Interactive OAuth conformance runs require the callback path to be /callback",
      );
    }

    hostname = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : 0;
    callbackPath = parsed.pathname;
  }

  let pendingResolve:
    | ((value: { code: string; state?: string }) => void)
    | undefined;
  let pendingReject: ((error: Error) => void) | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const failPending = (error: Error): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    pendingReject?.(error);
    pendingResolve = undefined;
    pendingReject = undefined;
  };

  const server = createServer((req, res) => {
    const requestUrl = new URL(
      req.url || callbackPath,
      `http://${hostname}:${resolvedPort}`,
    );

    if (requestUrl.pathname !== callbackPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      const description = requestUrl.searchParams.get("error_description");
      const message = description
        ? `${oauthError}: ${description}`
        : oauthError;
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<html><body><p>Authorization failed: ${escapeHtml(message)}. You can close this window.</p></body></html>`,
      );
      failPending(new Error(`Authorization server returned error: ${message}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.statusCode = 400;
      res.end("Missing authorization code");
      failPending(
        new Error(
          "Authorization callback was invoked without a code or error parameter",
        ),
      );
      return;
    }

    const state = requestUrl.searchParams.get("state") ?? undefined;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<html><body><p>Authorization received. You can close this window.</p></body></html>",
    );

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }

    pendingResolve?.({ code, state });
    pendingResolve = undefined;
    pendingReject = undefined;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine callback server address");
  }

  const resolvedPort = address.port;
  const redirectUrl = `http://${hostname}:${resolvedPort}${callbackPath}`;

  return {
    redirectUrl,
    async authorize({
      authorizationUrl,
      expectedState,
      timeoutMs,
      openUrl = openUrlInBrowser,
    }) {
      if (pendingResolve || pendingReject) {
        throw new Error("Interactive authorization is already in progress");
      }

      const codePromise = new Promise<AuthorizationCodeResult>(
        (resolve, reject) => {
          pendingResolve = ({ code, state }) => {
            if (expectedState && state !== expectedState) {
              reject(
                new Error(
                  `Authorization state mismatch. Expected ${expectedState}, received ${state ?? "missing"}`,
                ),
              );
              return;
            }

            resolve({ code });
          };
          pendingReject = reject;
          timeoutHandle = setTimeout(() => {
            pendingResolve = undefined;
            pendingReject = undefined;
            reject(
              new Error(
                `Interactive authorization timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        },
      );
      // Attach a no-op handler to suppress "unhandled rejection" warnings when
      // the callback server rejects before the caller awaits codePromise. The
      // original promise's rejection is still observable to the caller.
      codePromise.catch(() => undefined);

      try {
        await openUrl(authorizationUrl);
      } catch (error) {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        pendingResolve = undefined;
        pendingReject = undefined;
        throw error;
      }

      return codePromise;
    },
    async stop() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      pendingReject?.(new Error("Interactive authorization session closed"));
      pendingResolve = undefined;
      pendingReject = undefined;
      await closeServer(server);
    },
  };
}

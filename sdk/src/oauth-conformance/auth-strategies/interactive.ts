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

function getBrowserOpenCommand(url: string): {
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

const MCPJAM_CALLBACK_LOGO = `<svg width="1080" height="1080" viewBox="0 0 1080 1080" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g clip-path="url(#clip0_1_2)"><rect width="1080" height="1080" rx="241" ry="241" fill="#2D2D2D"/><path d="M196.547 508V298H245.447L332.447 440.8H306.647L391.247 298H440.147L440.747 508H386.147L385.547 381.1H394.847L331.547 487.3H305.147L240.047 381.1H251.447V508H196.547ZM587.477 512.2C570.877 512.2 555.477 509.6 541.277 504.4C527.277 499 515.077 491.4 504.677 481.6C494.477 471.8 486.477 460.3 480.677 447.1C474.877 433.7 471.977 419 471.977 403C471.977 387 474.877 372.4 480.677 359.2C486.477 345.8 494.477 334.2 504.677 324.4C515.077 314.6 527.277 307.1 541.277 301.9C555.477 296.5 570.877 293.8 587.477 293.8C606.877 293.8 624.177 297.2 639.377 304C654.777 310.8 667.577 320.6 677.777 333.4L639.977 367.6C633.177 359.6 625.677 353.5 617.477 349.3C609.477 345.1 600.477 343 590.477 343C581.877 343 573.977 344.4 566.777 347.2C559.577 350 553.377 354.1 548.177 359.5C543.177 364.7 539.177 371 536.177 378.4C533.377 385.8 531.977 394 531.977 403C531.977 412 533.377 420.2 536.177 427.6C539.177 435 543.177 441.4 548.177 446.8C553.377 452 559.577 456 566.777 458.8C573.977 461.6 581.877 463 590.477 463C600.477 463 609.477 460.9 617.477 456.7C625.677 452.5 633.177 446.4 639.977 438.4L677.777 472.6C667.577 485.2 654.777 495 639.377 502C624.177 508.8 606.877 512.2 587.477 512.2ZM704.262 508V298H800.262C819.462 298 835.962 301.1 849.762 307.3C863.762 313.5 874.562 322.5 882.162 334.3C889.762 345.9 893.562 359.7 893.562 375.7C893.562 391.5 889.762 405.2 882.162 416.8C874.562 428.4 863.762 437.4 849.762 443.8C835.962 450 819.462 453.1 800.262 453.1H737.262L763.662 427.3V508H704.262ZM763.662 433.6L737.262 406.3H796.662C809.062 406.3 818.262 403.6 824.262 398.2C830.462 392.8 833.562 385.3 833.562 375.7C833.562 365.9 830.462 358.3 824.262 352.9C818.262 347.5 809.062 344.8 796.662 344.8H737.262L763.662 317.5V433.6Z" fill="#FBFBFB"/><path d="M264.566 792.2C249.166 792.2 235.166 789.6 222.566 784.4C210.166 779 199.866 771.3 191.666 761.3L224.066 722.9C229.666 730.1 235.466 735.6 241.466 739.4C247.466 743 253.766 744.8 260.366 744.8C277.966 744.8 286.766 734.6 286.766 714.2V623.9H214.166V578H345.566V710.6C345.566 738 338.666 758.5 324.866 772.1C311.066 785.5 290.966 792.2 264.566 792.2ZM356.064 788L448.764 578H507.264L600.264 788H538.464L465.864 607.1H489.264L416.664 788H356.064ZM406.764 747.2L422.064 703.4H524.664L539.964 747.2H406.764ZM617.104 788V578H666.004L753.004 720.8H727.204L811.804 578H860.704L861.304 788H806.704L806.104 661.1H815.404L752.104 767.3H725.704L660.604 661.1H672.004V788H617.104Z" fill="#F2735B"/></g><defs><clipPath id="clip0_1_2"><rect width="1080" height="1080" rx="241" ry="241" fill="white"/></clipPath></defs></svg>`;

function renderCallbackPage(input: {
  tone: "success" | "error";
  title: string;
  message: string;
  detail?: string;
  caption: string;
}): string {
  const surface =
    input.tone === "success"
      ? "rgba(242, 115, 91, 0.08)"
      : "rgba(209, 78, 97, 0.08)";
  const border =
    input.tone === "success"
      ? "rgba(242, 115, 91, 0.18)"
      : "rgba(209, 78, 97, 0.18)";
  const detailHtml = input.detail
    ? `<p class="detail">${escapeHtml(input.detail)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCPJam | ${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --page-bg: #f6f3ef;
        --card-bg: rgba(255, 255, 255, 0.94);
        --card-border: rgba(34, 28, 30, 0.08);
        --card-shadow: 0 18px 42px rgba(26, 20, 22, 0.08);
        --text: #231c1f;
        --muted: #6f6568;
        --detail-bg: ${surface};
        --detail-border: ${border};
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --page-bg: #111013;
          --card-bg: rgba(26, 24, 27, 0.96);
          --card-border: rgba(255, 255, 255, 0.08);
          --card-shadow: 0 24px 56px rgba(0, 0, 0, 0.32);
          --text: #f5f2ef;
          --muted: #b0a6aa;
          --detail-bg: rgba(255, 255, 255, 0.04);
          --detail-border: rgba(255, 255, 255, 0.1);
        }
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        min-height: 100%;
      }

      body {
        margin: 0;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 32px 20px;
        background: var(--page-bg);
        color: var(--text);
        font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      .shell {
        width: min(100%, 396px);
      }

      .card {
        border-radius: 24px;
        border: 1px solid var(--card-border);
        padding: 34px 24px 26px;
        background: var(--card-bg);
        box-shadow: var(--card-shadow);
        text-align: center;
      }

      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 18px;
      }

      .logo {
        flex: none;
        width: 44px;
        height: 44px;
        overflow: hidden;
        border-radius: 14px;
        background: #2D2D2D;
      }

      .logo svg {
        display: block;
        width: 100%;
        height: 100%;
      }

      h1 {
        margin: 0;
        color: var(--text);
        font-size: clamp(1.45rem, 4.5vw, 1.95rem);
        font-weight: 600;
        line-height: 1.12;
        letter-spacing: -0.025em;
        text-wrap: balance;
      }

      .message,
      .detail,
      .caption {
        margin-left: auto;
        margin-right: auto;
      }

      .message {
        max-width: 100%;
        margin-top: 14px;
        margin-bottom: 0;
        color: var(--text);
        font-size: 14px;
        line-height: 1.6;
        text-wrap: pretty;
      }

      .detail {
        max-width: 100%;
        margin-top: 16px;
        padding: 12px 14px;
        border: 1px solid var(--detail-border);
        border-radius: 12px;
        background: var(--detail-bg);
        color: var(--text);
        font-family: "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        text-align: left;
      }

      .caption {
        margin-top: 16px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.6;
      }

      @media (max-width: 640px) {
        body {
          padding: 20px 16px;
        }

        .card {
          border-radius: 22px;
          padding: 30px 20px 24px;
        }

        .logo {
          width: 42px;
          height: 42px;
          border-radius: 13px;
        }

        .message {
          font-size: 14px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="card" role="status" aria-live="polite">
        <div class="brand">
          <div class="logo">${MCPJAM_CALLBACK_LOGO}</div>
        </div>
        <h1>${escapeHtml(input.title)}</h1>
        <p class="message">${escapeHtml(input.message)}</p>
        ${detailHtml}
        <p class="caption">${escapeHtml(input.caption)}</p>
      </section>
    </main>
  </body>
</html>`;
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
        "Interactive OAuth conformance runs require an http:// loopback redirect URL"
      );
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error(
        "Interactive OAuth conformance runs require a localhost or 127.0.0.1 redirect URL"
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
      `http://${hostname}:${resolvedPort}`
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
        renderCallbackPage({
          tone: "error",
          title: "Authorization failed",
          message: "Return to the terminal for details.",
          detail: message,
          caption: "You can close this window.",
        })
      );
      failPending(new Error(`Authorization server returned error: ${message}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        renderCallbackPage({
          tone: "error",
          title: "Authorization incomplete",
          message: "No authorization code was included in the callback.",
          detail:
            "Try the login flow again. If this keeps happening, inspect the provider's redirect URI configuration.",
          caption: "You can close this window.",
        })
      );
      failPending(
        new Error(
          "Authorization callback was invoked without a code or error parameter"
        )
      );
      return;
    }

    const state = requestUrl.searchParams.get("state") ?? undefined;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderCallbackPage({
        tone: "success",
        title: "Authorization complete",
        message: "Return to the terminal to continue.",
        caption: "You can close this window.",
      })
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
                  `Authorization state mismatch. Expected ${expectedState}, received ${state ?? "missing"}`
                )
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
                `Interactive authorization timed out after ${timeoutMs}ms`
              )
            );
          }, timeoutMs);
        }
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

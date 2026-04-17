import type { AuthorizationCodeResult } from "../types.js";
import type { InteractiveAuthorizationSession } from "./interactive.js";

/**
 * Input produced by the OAuth conformance runner when it reaches the
 * authorization step and is waiting for a code.
 */
export interface RemoteBrowserAuthorizationInput {
  authorizationUrl: string;
  expectedState?: string;
}

export interface RemoteBrowserAuthorizationCode {
  code: string;
  state?: string;
}

/**
 * Controller for driving an interactive OAuth conformance run from a host that
 * cannot use a local loopback redirect — for example, the MCP Inspector server
 * (local or hosted mode), where the browser redirect comes back to a public
 * `/oauth/callback` route rather than a `127.0.0.1:NNNN/callback` loopback.
 *
 * Pass {@link RemoteBrowserAuthorizationController.createSession} as the
 * `createInteractiveAuthorizationSession` dependency of `OAuthConformanceTest`.
 * Then `await` {@link RemoteBrowserAuthorizationController.awaitAuthorizationUrl}
 * to learn the URL to show the user, and call
 * {@link RemoteBrowserAuthorizationController.deliverCode} from your callback
 * handler once the user completes authorization.
 */
export interface RemoteBrowserAuthorizationController {
  /**
   * Resolves when the OAuth runner has produced an authorization URL and is
   * waiting for a code. Rejects if the runner fails before reaching that step.
   */
  readonly awaitAuthorizationUrl: Promise<RemoteBrowserAuthorizationInput>;

  /**
   * Deliver an authorization code from your user-facing callback. If
   * `expectedState` was captured and `state` here does not match, the pending
   * `authorize` call is rejected with a state-mismatch error.
   */
  deliverCode(result: RemoteBrowserAuthorizationCode): void;

  /**
   * Abort the flow with an error. Any pending `authorize` call — and the
   * `awaitAuthorizationUrl` promise if it has not yet resolved — are rejected.
   */
  fail(error: Error): void;

  /**
   * Pass this as the `createInteractiveAuthorizationSession` dep of
   * `OAuthConformanceTest`. The returned session shares state with the
   * controller: its `authorize` call resolves when `deliverCode` is invoked.
   */
  createSession(options?: {
    redirectUrl?: string;
  }): Promise<InteractiveAuthorizationSession>;
}

export interface RemoteBrowserAuthorizationControllerOptions {
  /**
   * Public URL of the OAuth callback your host exposes, e.g.
   * `https://app.example.com/oauth/callback/debug`. This is sent to the
   * authorization server as the `redirect_uri` parameter.
   */
  redirectUrl: string;

  /**
   * Optional hard timeout in milliseconds to wait for a code after the auth
   * URL is surfaced. When omitted, the timeout passed by the runner
   * (`stepTimeout`) is used.
   */
  codeTimeoutMs?: number;
}

export function createRemoteBrowserAuthorizationController(
  options: RemoteBrowserAuthorizationControllerOptions,
): RemoteBrowserAuthorizationController {
  if (!options.redirectUrl) {
    throw new Error(
      "redirectUrl is required for remote-browser OAuth conformance sessions",
    );
  }
  const redirectUrl = options.redirectUrl;

  let resolveAuthUrl:
    | ((input: RemoteBrowserAuthorizationInput) => void)
    | undefined;
  let rejectAuthUrl: ((error: Error) => void) | undefined;
  let authUrlSettled = false;

  const awaitAuthorizationUrl = new Promise<RemoteBrowserAuthorizationInput>(
    (resolve, reject) => {
      resolveAuthUrl = (input) => {
        authUrlSettled = true;
        resolve(input);
      };
      rejectAuthUrl = (error) => {
        authUrlSettled = true;
        reject(error);
      };
    },
  );
  // Prevent unhandled-rejection warnings if the host never awaits it (e.g.
  // the OAuth flow completes without needing user authorization).
  awaitAuthorizationUrl.catch(() => undefined);

  let pendingResolve: ((result: AuthorizationCodeResult) => void) | undefined;
  let pendingReject: ((error: Error) => void) | undefined;
  let activeExpectedState: string | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const clearPending = (): void => {
    pendingResolve = undefined;
    pendingReject = undefined;
    activeExpectedState = undefined;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  return {
    awaitAuthorizationUrl,
    deliverCode({ code, state }) {
      if (
        activeExpectedState !== undefined &&
        state !== undefined &&
        state !== activeExpectedState
      ) {
        const err = new Error(
          `Authorization state mismatch. Expected ${activeExpectedState}, received ${state}`,
        );
        pendingReject?.(err);
        clearPending();
        return;
      }
      pendingResolve?.({ code });
      clearPending();
    },
    fail(error) {
      if (!authUrlSettled) {
        rejectAuthUrl?.(error);
      }
      pendingReject?.(error);
      clearPending();
    },
    async createSession() {
      return {
        redirectUrl,
        async authorize({ authorizationUrl, expectedState, timeoutMs }) {
          if (pendingResolve || pendingReject) {
            throw new Error(
              "Remote-browser authorization is already in progress",
            );
          }
          activeExpectedState = expectedState;

          const codePromise = new Promise<AuthorizationCodeResult>(
            (resolve, reject) => {
              pendingResolve = resolve;
              pendingReject = reject;
              const effective = options.codeTimeoutMs ?? timeoutMs;
              if (
                typeof effective === "number" &&
                Number.isFinite(effective) &&
                effective > 0
              ) {
                timeoutHandle = setTimeout(() => {
                  clearPending();
                  reject(
                    new Error(
                      `Remote-browser authorization timed out after ${effective}ms`,
                    ),
                  );
                }, effective);
              }
            },
          );
          // Attach a no-op handler to suppress "unhandled rejection" warnings
          // when the session is aborted before the caller awaits codePromise.
          codePromise.catch(() => undefined);

          // Surface the authorization URL to the host only now that we have a
          // pending code listener — no race with the runner-has-not-yet-asked
          // case.
          resolveAuthUrl?.({ authorizationUrl, expectedState });

          return codePromise;
        },
        async stop() {
          if (pendingReject) {
            pendingReject(new Error("Remote-browser authorization session closed"));
          }
          clearPending();
        },
      };
    },
  };
}

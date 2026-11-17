/**
 * An uploaded test account's token often can't be refreshed: the upload may
 * carry no refresh token. When the server rejects it and the refresh says the
 * token can't be renewed, only a token uploaded since can help, so the same
 * connection is resolved again by its pinned id: a different token retries the
 * rejected exchange, and the same token or none stops with "upload a fresh
 * token". It never switches account or starts an OAuth flow.
 *
 * A read that finds nothing newer uses the connection up, and a read the
 * backend refuses (member removed, local runs withdrawn, export denied) also
 * disconnects it. Either way every later rejected exchange fails at once with
 * that error, with no further refresh or read. A refresh that failed for a
 * passing reason (another refresh holds the lease, a rate limit, an outage)
 * keeps its own error: the token may still renew.
 *
 * A newer token bound to another origin than the connection's (the server
 * moved since it opened) is never sent: the connection stops with "sign in
 * again", like a refresh that comes back bound elsewhere.
 *
 * The backend reports an upload apart from sharing: an upload on a shared
 * server is kind `shared` with `oauthAccountUploaded` (`accountUploaded` on a
 * listed account), on refusals as well as tokens. Older backends send only the
 * kind `uploaded`.
 */
import type { MCPClientManager, UnauthorizedRefreshHandler } from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  parseErrorMessage,
} from "../routes/web/errors.js";
import {
  oauthRefusalFromAuthorize,
  type AuthorizeOAuthOutcome,
} from "./local-oauth-refusal.js";
import { logger } from "./logger.js";
import { boundElsewhere, serverMovedError } from "./token-origin-check.js";

/** One server's entry in an authorize-batch answer, as this module reads it. */
type AuthorizeAnswer =
  | { ok: false; status: number; code: string; message: string }
  | ({
      ok: true;
      oauthCredentialId?: string;
      oauthBoundOrigins?: string[];
    } & AuthorizeOAuthOutcome);

/** Resolves one server again with exactly one account, without a refresh. */
export type ReResolveConnection = (
  serverId: string,
  connectionId: string,
) => Promise<{ results: Record<string, AuthorizeAnswer> }>;

/** The upload flag on an account entry the Inspector builds itself. */
export type UploadedAccountFlag = { accountUploaded?: boolean };

export type UploadedAccountRecovery = {
  /** The token the connection sends now. */
  current(): string | undefined;
  /** The token a refresh put in place. */
  sending(token: string): void;
  /** The error every rejected exchange gets once recovery has given up. */
  stopped(): WebRouteError | undefined;
  reject(): never;
  /**
   * After a refresh that can't renew `sent`, the token the rejected exchange
   * carried: a newer uploaded token bound to `targetOrigin`, or throws.
   */
  recover(
    serverKey: string,
    sent: string | undefined,
    targetOrigin?: string | null,
  ): Promise<string>;
};

/**
 * Whether `account` (an authorize result, or one of the accounts it lists)
 * is an uploaded account: by its own flags, or, for a result, by those of the
 * listed account `connectionId`.
 */
export function isUploadedAccount(
  account: unknown,
  connectionId?: string,
): boolean {
  if (!account || typeof account !== "object") return false;
  const field = (key: string): unknown => Reflect.get(account, key);
  if (
    field("accountUploaded") === true ||
    field("oauthAccountUploaded") === true ||
    field("accountKind") === "uploaded" ||
    field("oauthAccountKind") === "uploaded"
  ) {
    return true;
  }
  const listed = field("oauthConnections");
  return (
    Array.isArray(listed) &&
    listed.some(
      (entry: unknown) =>
        !!entry &&
        typeof entry === "object" &&
        Reflect.get(entry, "connectionId") === connectionId &&
        isUploadedAccount(entry),
    )
  );
}

/** Backend verdicts about this caller's access, as opposed to failures to answer. */
function isRefusalStatus(status: number): boolean {
  return status === 403 || status === 404;
}

/**
 * Whether a failed refresh says the token can't be renewed (no refresh token,
 * or one the authorization server turned down), so only a newer upload helps.
 */
function cannotRenew(error: unknown, rejected: unknown): boolean {
  // With no refresh token the refresh rethrows the server's own 401, to keep
  // its sign-in challenge.
  if (error === rejected) return true;
  const details = error instanceof WebRouteError ? error.details : undefined;
  return (
    details?.refreshTokenUnavailable === true ||
    details?.refreshTokenInvalid === true
  );
}

/** A fresh copy per exchange: the SDK attaches each exchange's own cause. */
function again(error: WebRouteError): WebRouteError {
  return new WebRouteError(
    error.status,
    error.code,
    error.message,
    error.details && { ...error.details },
  );
}

/**
 * Recoveries for the connections of one manager. `bind` hands over the
 * manager once it exists, so a refused re-resolve can disconnect.
 */
export function uploadedAccountRecoveries(reResolve: ReResolveConnection) {
  let manager: Pick<MCPClientManager, "disconnectServer"> | undefined;
  const disconnect = (key: string) =>
    // After the refused exchange has failed, so its operation reports the
    // refusal rather than the disconnect.
    setTimeout(() => {
      manager?.disconnectServer(key).catch((error: unknown) => {
        logger.debug("[uploaded account] disconnect after refusal failed", {
          serverId: key,
          error: parseErrorMessage(error),
        });
      });
    }, 0);
  return {
    bind(value: Pick<MCPClientManager, "disconnectServer">) {
      manager = value;
    },
    /** `undefined` unless the account is uploaded and its id is known. */
    for(args: {
      /** The authorize result, or the listed account the connection uses. */
      account: unknown;
      token: string | null | undefined;
      connectionId: string | undefined;
      serverId: string;
      serverName: string;
      /** The account's own name, when the server runs with several. */
      accountName?: string;
    }): UploadedAccountRecovery | undefined {
      const { connectionId, serverId, serverName, accountName } = args;
      if (!connectionId || !isUploadedAccount(args.account, connectionId)) {
        return undefined;
      }
      let current = args.token ?? undefined;
      let stopped: WebRouteError | undefined;
      let reading: Promise<string> | undefined;
      const stop = (error: WebRouteError, disconnectKey?: string): never => {
        stopped = error;
        if (disconnectKey) disconnect(disconnectKey);
        throw error;
      };
      const uploadFresh = () =>
        new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          accountName
            ? `${serverName} rejected the uploaded token for "${accountName}". Upload a fresh token for "${accountName}", then run again.`
            : `${serverName} rejected its uploaded token. Upload a fresh token for ${serverName}, then run again.`,
          { uploadedAccount: true, serverId, serverName },
        );
      const read = async (
        serverKey: string,
        sent: string | undefined,
        targetOrigin: string | null | undefined,
      ) => {
        let answer: AuthorizeAnswer | undefined;
        try {
          answer = (await reResolve(serverId, connectionId)).results[serverId];
        } catch (error) {
          if (error instanceof WebRouteError && isRefusalStatus(error.status)) {
            stop(error, serverKey);
          }
          throw error;
        }
        if (answer && !answer.ok) {
          const refusal = new WebRouteError(
            answer.status,
            answer.code as ErrorCode,
            answer.message,
            { serverId, serverName },
          );
          if (isRefusalStatus(answer.status)) stop(refusal, serverKey);
          throw refusal;
        }
        const withheld =
          answer && oauthRefusalFromAuthorize(answer, { serverId, serverName });
        if (withheld) stop(withheld, serverKey);
        const token = answer?.oauthAccessToken?.trim();
        // The same account or nothing: an answer for another account is
        // treated as no token at all.
        const sameAccount =
          !answer?.oauthCredentialId ||
          answer.oauthCredentialId === connectionId;
        if (token && sameAccount && token !== sent) {
          if (boundElsewhere(answer?.oauthBoundOrigins, targetOrigin)) {
            stop(serverMovedError(serverId, serverName));
          }
          current = token;
          return token;
        }
        // A token another exchange put in place while this one read.
        if (current && current !== sent) return current;
        return stop(uploadFresh());
      };
      return {
        current: () => current,
        sending(token) {
          current = token;
        },
        stopped: () => stopped && again(stopped),
        reject: () => stop(uploadFresh()),
        async recover(serverKey, sent, targetOrigin) {
          if (stopped) throw again(stopped);
          // Another exchange already replaced the token this one was
          // rejected with.
          if (current && current !== sent) return current;
          reading ??= read(serverKey, sent, targetOrigin).finally(() => {
            reading = undefined;
          });
          return reading;
        },
      };
    },
  };
}

/**
 * `handler`, with an uploaded account's re-resolve when a refresh can't renew
 * its token. `targetOrigin` is where the connection sends its token.
 */
export function withUploadedAccountRecovery(
  handler: UnauthorizedRefreshHandler,
  recovery: UploadedAccountRecovery | undefined,
  targetOrigin?: string | null,
): UnauthorizedRefreshHandler {
  if (!recovery) return handler;
  const fromRefresh = (error: unknown) =>
    error instanceof WebRouteError
      ? error.withSetupFailureSource("oauth_refresh")
      : error;
  return async (context) => {
    const stopped = recovery.stopped();
    if (stopped) throw fromRefresh(stopped);
    // The SDK hands over no request, so the token in place when the 401
    // arrives stands for the one the rejected exchange sent.
    const sent = recovery.current();
    try {
      const result = await handler(context);
      recovery.sending(result.accessToken);
      return { ...result, onRetryRejected: () => recovery.reject() };
    } catch (error) {
      if (!cannotRenew(error, context.error)) throw error;
      logger.debug("[uploaded account] refresh can't renew; resolving again", {
        serverId: context.serverId,
        error: parseErrorMessage(error),
      });
    }
    try {
      return {
        onRetryRejected: () => recovery.reject(),
        accessToken: await recovery.recover(
          context.serverId,
          sent,
          targetOrigin,
        ),
      };
    } catch (failure) {
      throw fromRefresh(failure);
    }
  };
}

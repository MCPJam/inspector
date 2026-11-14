/**
 * The login a local turn runs on when its CLI reaches its own vendor rather
 * than MCPJam's model proxy (a `runtime-login` credential, today Cursor).
 *
 * Asked of the backend once per turn and cleared when the turn ends. The
 * backend exchanges the organization's key for the vendor's access token and
 * returns that alone: it expires within the hour, and there is no refresh
 * token to renew it with, so a later turn asks again. Every request is signed
 * by this machine's instance key, like the model proxy's, so the member's
 * bearer alone cannot fetch one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { harnessDisplayName } from "../../../../shared/harness-model-support.js";
import { inspectorAiRequestHeaders } from "../../ai-request-headers.js";
import { logger } from "../../logger.js";
import { bearerHeader, getConvexHttpUrl } from "../harness-broker-http.js";
import { signProxiedRequest } from "./instance-key.js";
import type { LocalRuntimeLogin } from "./runtimes/types.js";

export const RUNTIME_LOGIN_INSTALL_PATH =
  "/web/harness/local-runtime-login/install";
export const RUNTIME_LOGIN_CLEAR_PATH =
  "/web/harness/local-runtime-login/clear";

/** What a login request signs as its `jti`, as the backend checks it. */
export const runtimeLoginJti = (installId: string) =>
  `local-runtime-login:${installId}`;

/** Who asks, from which machine, for which local work. Ids only. */
export interface RuntimeLoginScope {
  harnessId: string;
  projectId: string;
  modelId: string;
  machineId: string;
  keyId: string;
  evalIterationId?: string;
  journeyRunId?: string;
  hostId?: string;
  targetId?: string;
  sessionIdx?: number;
}

export type RuntimeLoginResult =
  | { ok: true; installId: string; login: LocalRuntimeLogin }
  | { ok: false; message: string };

function scopeBody(scope: RuntimeLoginScope) {
  return {
    harnessId: scope.harnessId,
    projectId: scope.projectId,
    modelId: scope.modelId,
    machineId: scope.machineId,
    keyId: scope.keyId,
    ...(scope.evalIterationId
      ? { evalIterationId: scope.evalIterationId }
      : {}),
    ...(scope.journeyRunId
      ? {
          journeyRunId: scope.journeyRunId,
          hostId: scope.hostId,
          targetId: scope.targetId,
          sessionIdx: scope.sessionIdx,
        }
      : {}),
  };
}

async function post(
  path: string,
  body: Record<string, unknown>,
  args: { installId: string; bearer: string; signal?: AbortSignal },
): Promise<Response> {
  const pop = await signProxiedRequest({
    method: "POST",
    path,
    jti: runtimeLoginJti(args.installId),
    nonce: randomBytes(16).toString("base64url"),
  });
  return fetch(new URL(path, getConvexHttpUrl()).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...inspectorAiRequestHeaders("harness"),
      authorization: bearerHeader(args.bearer),
      "x-mcpjam-pop": pop,
    },
    body: JSON.stringify(body),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // Not JSON (a proxy's error page, say): the status is reported instead.
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function installRuntimeLogin(
  args: RuntimeLoginScope & { bearer: string; signal?: AbortSignal },
): Promise<RuntimeLoginResult> {
  const name = harnessDisplayName(args.harnessId);
  const installId = randomUUID();
  let response: Response;
  try {
    response = await post(
      RUNTIME_LOGIN_INSTALL_PATH,
      { ...scopeBody(args), installId },
      {
        installId,
        bearer: args.bearer,
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
  } catch (error) {
    logger.warn("[local-harness] runtime login request failed", {
      harnessId: args.harnessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      message: `MCPJam could not be reached for a ${name} login. Check your connection and retry.`,
    };
  }
  const payload = await readJson(response);
  if (
    response.ok &&
    isRecord(payload) &&
    payload.ok === true &&
    payload.installId === installId &&
    typeof payload.accessToken === "string" &&
    payload.accessToken.length > 0 &&
    typeof payload.expiresAt === "number" &&
    Number.isFinite(payload.expiresAt)
  ) {
    return {
      ok: true,
      installId,
      login: { accessToken: payload.accessToken, expiresAt: payload.expiresAt },
    };
  }
  // The backend's refusals are written for the member; anything else is logged
  // with its status and reported plainly.
  if (
    isRecord(payload) &&
    typeof payload.error === "string" &&
    payload.error.length > 0
  ) {
    return { ok: false, message: payload.error };
  }
  logger.warn("[local-harness] runtime login refused without a reason", {
    harnessId: args.harnessId,
    status: response.status,
  });
  return {
    ok: false,
    message: `MCPJam could not prepare a ${name} login. Try again in a moment.`,
  };
}

/** Best effort: the login expires within the hour whatever happens here. */
export async function clearRuntimeLogin(
  args: RuntimeLoginScope & { installId: string; bearer: string },
): Promise<void> {
  try {
    const response = await post(
      RUNTIME_LOGIN_CLEAR_PATH,
      { ...scopeBody(args), installId: args.installId },
      args,
    );
    await response.body?.cancel();
  } catch (error) {
    logger.warn("[local-harness] runtime login clear failed", {
      harnessId: args.harnessId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

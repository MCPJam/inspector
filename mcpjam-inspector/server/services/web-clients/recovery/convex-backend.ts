/**
 * The reconnect backend over the backend's Inspector-service functions,
 * `webClientService:read` and `:apply`, called as `plugin-host/service-store`
 * calls its stores: a Convex client with no user bearer, the service
 * credential as an argument, and each command acting for one person, whom the
 * backend holds to the same permissions as in the app. A profile save takes a
 * data key from a service-token route, encrypts the profile here and uploads
 * only the ciphertext. Refusals throw `WebBackendRefusal`s with the backend's
 * codes.
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { logger } from "../../../utils/logger.js";
import {
  getServiceCredential,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../../service-credential.js";
import type { LedgerEntry, LedgerMatch } from "../tool-call-ledger.js";
import {
  WebBackendRefusal,
  type ClaimedRun,
  type PendingStep,
  type SaveProfileResult,
  type WebAccountRecord,
  type WebReconnectBackend,
  type WebReconnectRequest,
} from "./backend.js";
import { sealWebProfile } from "./profile-cipher.js";
import type { LedgerReader } from "./reconcile.js";

/** The person a command acts for: a WorkOS id or a backend user id. */
export type WebActor = { actorExternalId: string } | { actorUserId: string };

export type WebServiceOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

type Command = { action: string } & Record<string, unknown>;
type ReadArgs = { serviceToken: string; requestId: string; command: Command };
type ApplyArgs = { serviceToken: string; command: Command };

const SERVICE_TIMEOUT_MS = 15_000;
/** A profile archive can be large, so its upload gets longer. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** A Convex function's refusal, or a route's `{ error: { code } }` body. */
function refusalOf(error: unknown): WebBackendRefusal | undefined {
  // A network error has a `code` too (ECONNRESET); only the backend refuses.
  if (error instanceof Error && error.name !== "ConvexError") return undefined;
  const data = error instanceof Error && "data" in error ? error.data : error;
  const body =
    typeof data === "object" && data !== null && "error" in data
      ? data.error
      : data;
  if (typeof body !== "object" || body === null || !("code" in body)) return;
  if (typeof body.code !== "string") return;
  const message = "message" in body ? body.message : undefined;
  return new WebBackendRefusal(
    body.code,
    typeof message === "string" ? message : undefined,
  );
}

function webClientService(options: WebServiceOptions) {
  const env = options.env ?? process.env;
  const serviceToken = getServiceCredential(env);
  const convexUrl = env.CONVEX_URL?.trim();
  const httpUrl = env.CONVEX_HTTP_URL?.trim();
  if (!serviceToken || !convexUrl || !httpUrl) {
    throw new Error(
      "Web accounts need the service credential, CONVEX_URL and CONVEX_HTTP_URL.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timed =
    (ms: number): typeof fetch =>
    (input, init) =>
      fetchImpl(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(ms),
      });
  // No user bearer is set: the service credential is the only authority.
  const client = new ConvexHttpClient(convexUrl, {
    logger: false,
    fetch: timed(SERVICE_TIMEOUT_MS),
  });
  const refused = (error: unknown): never => {
    throw refusalOf(error) ?? error;
  };
  return {
    read: <T>(command: Command) =>
      client
        .query(
          makeFunctionReference<"query", ReadArgs, T>("webClientService:read"),
          {
            serviceToken,
            requestId: randomUUID(),
            command,
          },
        )
        .catch(refused),
    apply: <T>(command: Command) =>
      client
        .mutation(
          makeFunctionReference<"mutation", ApplyArgs, T>(
            "webClientService:apply",
          ),
          { serviceToken, command },
          { skipQueue: true },
        )
        .catch(refused),
    /** A service-token route; it answers refusals with the same codes. */
    async post(path: string, body: Record<string, unknown>) {
      const reply = await timed(SERVICE_TIMEOUT_MS)(new URL(path, httpUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken,
        },
        body: JSON.stringify(body),
      });
      const data: unknown = await reply.json();
      if (!reply.ok) throw refusalOf(data) ?? new Error(`HTTP ${reply.status}`);
      return (data ?? {}) as Record<string, unknown>;
    },
    async upload(uploadUrl: string, sealed: Uint8Array) {
      const reply = await timed(UPLOAD_TIMEOUT_MS)(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(sealed),
      });
      const { storageId } = ((await reply.json()) ?? {}) as Record<
        string,
        unknown
      >;
      if (!reply.ok || typeof storageId !== "string") {
        throw new Error("The encrypted profile was not uploaded.");
      }
      return storageId;
    },
  };
}

/** A claimed run's step as the runtime wrote it, or undefined if unreadable. */
function pendingStepOf(text: string): PendingStep | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Unreadable JSON is reported by the caller, with the run it belongs to.
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (!("stepId" in value) || typeof value.stepId !== "string") return;
  if (!("startedAt" in value) || typeof value.startedAt !== "string") return;
  const turnId = "turnId" in value ? value.turnId : undefined;
  return {
    stepId: value.stepId,
    startedAt: value.startedAt,
    ...(typeof turnId === "string" ? { turnId } : {}),
  };
}

export function createConvexWebReconnectBackend(
  actor: WebActor,
  options: WebServiceOptions = {},
): WebReconnectBackend {
  const service = webClientService(options);
  const act = (command: Command): Command => ({ ...actor, ...command });
  return {
    listWebAccounts: (args) =>
      service.read<WebAccountRecord[]>(
        act({ action: "listWebAccounts", ...args }),
      ),
    listWebReconnectRequests: (args) =>
      service.read<WebReconnectRequest[]>(
        act({ action: "listWebReconnectRequests", ...args }),
      ),
    async markWebAccountNeedsSignIn(args) {
      await service.apply(
        act({ action: "markWebAccountNeedsSignIn", ...args }),
      );
    },
    reportWebSignInRequired: ({ pendingStep, ...args }) =>
      service.apply<{ requestId: string; shouldNotify: boolean }>(
        act({
          action: "reportWebSignInRequired",
          ...args,
          pendingStep: JSON.stringify(pendingStep),
        }),
      ),
    handbackWebReconnect: (args) =>
      service.apply<{ resumableRunIds: string[] }>(
        act({ action: "handbackWebReconnect", ...args }),
      ),
    async claimResumableWebRuns(args) {
      const runs = await service.apply<
        Array<Omit<ClaimedRun, "pendingStep"> & { pendingStep: string }>
      >(act({ action: "claimResumableWebRuns", ...args }));
      return runs.flatMap(({ pendingStep, ...run }) => {
        const step = pendingStepOf(pendingStep);
        if (step) return [{ ...run, pendingStep: step }];
        // A claimed run is never handed out again, so a person must send it again.
        logger.error(
          "[web-recovery] A claimed run's step is unreadable",
          undefined,
          {
            runId: run.runId,
          },
        );
        return [];
      });
    },
    async saveWebAccountProfile({ profile, savedFromRunId, ...args }) {
      const key = await service.post("/internal/v1/web-accounts/profile-key", {
        ...actor,
        webAccountId: args.webAccountId,
      });
      const { expectedProfileVersion, dataKey, wrappedKey, uploadUrl } = key;
      if (
        typeof expectedProfileVersion !== "number" ||
        typeof dataKey !== "string" ||
        typeof wrappedKey !== "string" ||
        typeof uploadUrl !== "string"
      ) {
        throw new Error("The backend's profile key answer is malformed.");
      }
      // The key opens only for the version after the one it was issued at.
      if (expectedProfileVersion !== args.expectedProfileVersion) {
        const profileVersion = expectedProfileVersion;
        return { ok: false, reason: "version_conflict", profileVersion };
      }
      const keyBytes = Buffer.from(dataKey, "base64");
      let sealed: Buffer;
      try {
        sealed = sealWebProfile(profile, keyBytes);
      } finally {
        keyBytes.fill(0);
      }
      const storageId = await service.upload(uploadUrl, sealed);
      return service.apply<SaveProfileResult>(
        act({
          action: "saveWebAccountProfile",
          ...args,
          storageId,
          wrappedKey,
          ...(savedFromRunId ? { savedFromRunId } : {}),
        }),
      );
    },
  };
}

/** The durable ledger's read side, for `reconcileBeforeResend`. */
export function createConvexLedgerReader(
  options: WebServiceOptions = {},
): LedgerReader {
  const service = webClientService(options);
  const find = (match: LedgerMatch | { turnId: string }) =>
    service.read<LedgerEntry[]>({ action: "findWebToolCalls", ...match });
  return { find, forTurn: (turnId) => find({ turnId }) };
}

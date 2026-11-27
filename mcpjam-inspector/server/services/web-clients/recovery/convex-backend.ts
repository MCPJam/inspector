/**
 * The reconnect backend over the backend's Inspector-service functions,
 * through the process's one `webClientService()` client: no user bearer, the
 * service credential as authority, and each command acting for one person,
 * whom the backend holds to the same permissions as in the app. A profile
 * save takes a data key from a service-token route, encrypts the profile here
 * and uploads only the ciphertext. Refusals throw `WebBackendRefusal`s with
 * the backend's codes.
 */
import { z } from "zod";
import { WEB_CLIENT_VENDORS } from "../../../../shared/web-clients.js";
import { logger } from "../../../utils/logger.js";
import { getInternalBackendConfig } from "../../internal-backend.js";
import { INSPECTOR_SERVICE_TOKEN_HEADER } from "../../service-credential.js";
import {
  webClientService,
  type WebClientService,
} from "../backend-connector-resolver.js";
import type { LedgerEntry, LedgerMatch } from "../tool-call-ledger.js";
import {
  WebBackendRefusal,
  type ClaimedRun,
  type PendingStep,
  type WebReconnectBackend,
} from "./backend.js";
import { sealWebProfile } from "./profile-cipher.js";
import type { LedgerReader } from "./reconcile.js";

/** The person a command acts for: a WorkOS id or a backend user id. */
export type WebActor = { actorExternalId: string } | { actorUserId: string };

/** The service-token route that issues a profile's data key. */
export type ProfileKeyRoute = {
  convexHttpUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
};

type Command = { action: string } & Record<string, unknown>;

/** A profile archive can be large, so its upload gets longer than a call. */
const ROUTE_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const account = z.object({
  webAccountId: z.string(),
  projectId: z.string(),
  vendor: z.enum(WEB_CLIENT_VENDORS).optional(),
  status: z.enum(["ready", "needs_sign_in", "checking"]),
  accountEmail: z.string().optional(),
  workspaceName: z.string().optional(),
  profileVersion: z.number(),
});
const request = z.object({
  requestId: z.string(),
  webAccountId: z.string(),
  status: z.enum(["open", "resolved", "cancelled"]),
  reason: z.string(),
  openedAt: z.number(),
  notifiedAt: z.number().optional(),
  notificationCount: z.number(),
  resolvedAt: z.number().optional(),
  waitingRunCount: z.number(),
});
const pendingStep = z.object({
  stepId: z.string(),
  startedAt: z.string(),
  turnId: z.string().optional(),
});
const claimed = z.object({
  runId: z.string(),
  iterationId: z.string().optional(),
  requestId: z.string(),
  pendingStep: z.string(),
});
const saved = z.union([
  z.object({ ok: z.literal(true), profileVersion: z.number() }),
  z.object({
    ok: z.literal(false),
    reason: z.literal("version_conflict"),
    profileVersion: z.number(),
  }),
]);
const profileKey = z.object({
  expectedProfileVersion: z.number(),
  dataKey: z.string().min(1),
  wrappedKey: z.string().min(1),
  uploadUrl: z.string().url(),
});
const ledgerEntry = z.object({
  id: z.string(),
  connectorId: z.string(),
  turnId: z.string().optional(),
  runId: z.string().optional(),
  jsonrpcId: z.string(),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  argsHash: z.string(),
  state: z.enum(["forwarded", "result", "error", "lost"]),
  forwardedAt: z.string(),
  settledAt: z.string().optional(),
  upstreamStatus: z.number().optional(),
  resultHash: z.string().optional(),
});

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

/** A refused reply's JSON body. A proxy's error page has none. */
async function refusalBody(reply: Response): Promise<unknown> {
  const text = await reply.text();
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the status is all there is to report.
    return undefined;
  }
}

/** Commands carry no undefined field: Convex refuses one. */
function defined(command: Command): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(command).filter(([, value]) => value !== undefined),
  );
}

function refusing(service: WebClientService) {
  const refused = (error: unknown): never => {
    throw refusalOf(error) ?? error;
  };
  return {
    read: <T>(schema: z.ZodType<T>, command: Command) =>
      service
        .read(defined(command))
        .then((value) => schema.parse(value), refused),
    apply: <T>(schema: z.ZodType<T>, command: Command) =>
      service
        .apply(defined(command))
        .then((value) => schema.parse(value), refused),
  };
}

async function postJson(
  route: ProfileKeyRoute,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const reply = await (route.fetchImpl ?? fetch)(
    new URL(path, route.convexHttpUrl),
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: route.serviceToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    },
  );
  if (!reply.ok) {
    throw refusalOf(await refusalBody(reply)) ?? new Error(`HTTP ${reply.status}`);
  }
  const data: unknown = await reply.json();
  return data;
}

async function upload(
  route: ProfileKeyRoute,
  uploadUrl: string,
  sealed: Uint8Array,
): Promise<string> {
  const reply = await (route.fetchImpl ?? fetch)(uploadUrl, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(sealed),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!reply.ok) {
    throw new Error(`The encrypted profile was not uploaded: HTTP ${reply.status}.`);
  }
  const answer = z
    .object({ storageId: z.string() })
    .safeParse(await reply.json());
  if (!answer.success) {
    throw new Error("The encrypted profile was not uploaded.");
  }
  return answer.data.storageId;
}

/** This process's backend client; pass the one already held where there is one. */
function processService(): WebClientService {
  const service = webClientService();
  if (!service) {
    throw new Error(
      "Web accounts need MCPJam's hosted backend and its service credential.",
    );
  }
  return service;
}

/** The profile-key route on this process's backend. */
function processProfileKeyRoute(): ProfileKeyRoute {
  const { convexUrl, serviceToken } = getInternalBackendConfig("Web accounts");
  return { convexHttpUrl: convexUrl, serviceToken };
}

export function createConvexWebReconnectBackend(
  actor: WebActor,
  deps: { service?: WebClientService; route?: ProfileKeyRoute } = {},
): WebReconnectBackend {
  const { read, apply } = refusing(deps.service ?? processService());
  const act = (command: Command): Command => ({ ...actor, ...command });
  return {
    listWebAccounts: (args) =>
      read(z.array(account), act({ action: "listWebAccounts", ...args })),
    listWebReconnectRequests: (args) =>
      read(
        z.array(request),
        act({ action: "listWebReconnectRequests", ...args }),
      ),
    async markWebAccountNeedsSignIn(args) {
      await apply(
        z.unknown(),
        act({ action: "markWebAccountNeedsSignIn", ...args }),
      );
    },
    reportWebSignInRequired: ({ pendingStep: step, ...args }) =>
      apply(
        z.union([
          z.object({ requestId: z.string(), shouldNotify: z.boolean() }),
          // Signed in again since the run restored its profile.
          z.object({ reloadProfile: z.literal(true) }),
        ]),
        act({
          action: "reportWebSignInRequired",
          ...args,
          pendingStep: JSON.stringify(step),
        }),
      ),
    handbackWebReconnect: (args) =>
      apply(
        z.object({ resumableRunIds: z.array(z.string()) }),
        act({ action: "handbackWebReconnect", ...args }),
      ),
    async claimResumableWebRuns(args) {
      const runs = await apply(
        z.array(claimed),
        act({ action: "claimResumableWebRuns", ...args }),
      );
      return runs.flatMap((run): ClaimedRun[] => {
        const step = readPendingStep(run.pendingStep);
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
      const route = deps.route ?? processProfileKeyRoute();
      const key = profileKey.parse(
        await postJson(route, "/internal/v1/web-accounts/profile-key", {
          ...actor,
          webAccountId: args.webAccountId,
        }),
      );
      // The key opens only for the version after the one it was issued at.
      if (key.expectedProfileVersion !== args.expectedProfileVersion) {
        const profileVersion = key.expectedProfileVersion;
        return { ok: false, reason: "version_conflict", profileVersion };
      }
      const keyBytes = Buffer.from(key.dataKey, "base64");
      let sealed: Buffer;
      try {
        sealed = sealWebProfile(profile, keyBytes);
      } finally {
        keyBytes.fill(0);
      }
      const storageId = await upload(route, key.uploadUrl, sealed);
      return apply(
        saved,
        act({
          action: "saveWebAccountProfile",
          ...args,
          storageId,
          wrappedKey: key.wrappedKey,
          savedFromRunId,
        }),
      );
    },
  };
}

/** A claimed run's step as the runtime wrote it, or undefined if unreadable. */
function readPendingStep(text: string): PendingStep | undefined {
  try {
    const step = pendingStep.safeParse(JSON.parse(text));
    return step.success ? step.data : undefined;
  } catch {
    // Unreadable JSON is reported by the caller, with the run it belongs to.
    return undefined;
  }
}

/** The durable ledger's read side, for `reconcileBeforeResend`. */
export function createConvexLedgerReader(
  service: WebClientService = processService(),
): LedgerReader {
  const { read } = refusing(service);
  const find = (
    match: LedgerMatch | { turnId: string },
  ): Promise<LedgerEntry[]> =>
    read(z.array(ledgerEntry), { action: "findWebToolCalls", ...match });
  return { find, forTurn: (turnId) => find({ turnId }) };
}

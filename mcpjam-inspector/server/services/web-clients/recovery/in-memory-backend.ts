/**
 * The reconnect backend's rules in one process, for tests and the local
 * tracer. State changes never await midway, so each method is atomic, as the
 * backend's mutations are; the notice goes out afterwards, as the backend's
 * scheduled email does.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../../utils/logger.js";
import {
  identityOf,
  sameWebIdentity,
  WebBackendRefusal,
  type ClaimedRun,
  type SignInReason,
  type WebAccountRecord,
  type WebReconnectBackend,
  type WebReconnectRequest,
} from "./backend.js";

/** The one notice of a request, which the backend emails its reconnect owner. */
export type WebReconnectNotice = {
  requestId: string;
  projectId: string;
  webAccountId: string;
  reason: SignInReason;
};

type WaitingRun = Omit<ClaimedRun, "requestId"> & {
  status: "waiting" | "resumable" | "resumed";
};
type StoredRequest = WebReconnectRequest &
  WebReconnectNotice & { runs: WaitingRun[] };

export function createInMemoryWebReconnectBackend(
  seed: readonly WebAccountRecord[] = [],
  sendNotice: (notice: WebReconnectNotice) => void | Promise<void> = () => {},
): WebReconnectBackend {
  const accounts = new Map(
    seed.map((account) => [account.webAccountId, { ...account }]),
  );
  const requests = new Map<string, StoredRequest>();
  const accountById = (webAccountId: string) => {
    const account = accounts.get(webAccountId);
    if (!account) throw new WebBackendRefusal("NOT_FOUND");
    return account;
  };

  return {
    async listWebAccounts({ projectId }) {
      return [...accounts.values()]
        .filter((account) => account.projectId === projectId)
        .map((account) => structuredClone(account));
    },
    async markWebAccountNeedsSignIn({ webAccountId }) {
      accountById(webAccountId).status = "needs_sign_in";
    },
    async saveWebAccountProfile({ webAccountId, expectedProfileVersion }) {
      const account = accountById(webAccountId);
      const { profileVersion } = account;
      if (profileVersion !== expectedProfileVersion) {
        return { ok: false, reason: "version_conflict", profileVersion };
      }
      // The profile itself stays with the caller: nothing here restores it.
      account.profileVersion += 1;
      return { ok: true, profileVersion: account.profileVersion };
    },
    async reportWebSignInRequired({ webAccountId, runId, ...report }) {
      const account = accountById(webAccountId);
      const { restoredProfileVersion } = report;
      if (
        account.status === "ready" &&
        restoredProfileVersion !== undefined &&
        account.profileVersion > restoredProfileVersion
      ) {
        return { reloadProfile: true };
      }
      account.status = "needs_sign_in";
      let request = [...requests.values()].find(
        (one) => one.webAccountId === webAccountId && one.status === "open",
      );
      const shouldNotify = request === undefined;
      if (!request) {
        request = {
          requestId: randomUUID(),
          projectId: account.projectId,
          webAccountId,
          status: "open",
          reason: report.reason,
          openedAt: Date.now(),
          notificationCount: 0,
          waitingRunCount: 0,
          runs: [],
        };
        requests.set(request.requestId, request);
      }
      if (!request.runs.some((run) => run.runId === runId)) {
        request.runs.push({
          runId,
          ...(report.iterationId ? { iterationId: report.iterationId } : {}),
          pendingStep: structuredClone(report.pendingStep),
          status: "waiting",
        });
      }
      if (shouldNotify) deliver(request);
      return { requestId: request.requestId, shouldNotify };
    },
    async handbackWebReconnect({ requestId, verifiedAccountEmail, ...rest }) {
      const request = requests.get(requestId);
      if (!request) throw new WebBackendRefusal("NOT_FOUND");
      const account = accountById(request.webAccountId);
      if (request.status === "cancelled") {
        throw new WebBackendRefusal("CONFLICT", "The request was cancelled.");
      }
      if (request.status === "open") {
        // A recorded seat refuses any other, workspace included; an account
        // with none records this one.
        const email = verifiedAccountEmail.trim();
        const workspace = rest.verifiedWorkspace?.trim();
        const known = identityOf(account);
        const verified = { accountEmail: email, workspaceName: workspace };
        if (known && !sameWebIdentity(known, verified)) {
          throw new WebBackendRefusal("CONFLICT", "Another seat signed in.");
        }
        request.status = "resolved";
        request.resolvedAt = Date.now();
        account.status = "ready";
        account.accountEmail = email;
        if (workspace) account.workspaceName = workspace;
        for (const run of request.runs) {
          if (run.status === "waiting") run.status = "resumable";
        }
      }
      const resumable = request.runs.filter((run) => run.status !== "waiting");
      return { resumableRunIds: resumable.map((run) => run.runId) };
    },
    async claimResumableWebRuns({ webAccountId }) {
      const claimed: ClaimedRun[] = [];
      for (const request of requests.values()) {
        if (request.webAccountId !== webAccountId) continue;
        for (const run of request.runs) {
          if (run.status !== "resumable") continue;
          run.status = "resumed";
          const { status: _, ...claim } = structuredClone(run);
          claimed.push({ requestId: request.requestId, ...claim });
        }
      }
      return claimed;
    },
    async listWebReconnectRequests({ projectId }) {
      // Newest first, as the backend lists them.
      return [...requests.values()]
        .filter((request) => request.projectId === projectId)
        .reverse()
        .map(({ projectId: _, runs, ...request }) => ({
          ...structuredClone(request),
          waitingRunCount: runs.filter((run) => run.status === "waiting")
            .length,
        }));
    },
  };

  function deliver(request: StoredRequest) {
    const { requestId, projectId, webAccountId, reason } = request;
    const notice = { requestId, projectId, webAccountId, reason };
    void Promise.resolve()
      .then(() => sendNotice(notice))
      .then(
        () => {
          request.notificationCount += 1;
          request.notifiedAt ??= Date.now();
        },
        (error: unknown) =>
          logger.error("[web-recovery] The reconnect notice failed", error, {
            requestId,
          }),
      );
  }
}

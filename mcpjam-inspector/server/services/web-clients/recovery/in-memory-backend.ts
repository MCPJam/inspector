/**
 * The reconnect backend's rules in one process, for tests and the local
 * tracer. No method awaits midway, so each is atomic, as the backend's
 * mutations are.
 */
import { randomUUID } from "node:crypto";
import {
  identityOf,
  sameWebIdentity,
  type ClaimedRun,
  type WebAccountRecord,
  type WebReconnectBackend,
  type WebReconnectRequest,
} from "./backend.js";

export function createInMemoryWebReconnectBackend(
  seed: readonly WebAccountRecord[] = [],
): WebReconnectBackend {
  const accounts = new Map(
    seed.map((account) => [account.webAccountId, { ...account }]),
  );
  const requests = new Map<string, WebReconnectRequest>();
  const now = () => new Date().toISOString();
  const accountById = (webAccountId: string) => {
    const account = accounts.get(webAccountId);
    if (!account) throw new Error(`Web account ${webAccountId} was not found.`);
    return account;
  };

  return {
    async listWebAccounts({ projectId }) {
      return [...accounts.values()]
        .filter((account) => account.projectId === projectId)
        .map((account) => structuredClone(account));
    },
    async markWebAccountVerified({ webAccountId, ...identity }) {
      const account = accountById(webAccountId);
      const expected = identityOf(account);
      // An account is one vendor seat; verifying it as someone else is refused.
      if (expected && !sameWebIdentity(expected, identity)) {
        throw new Error(`Web account ${webAccountId} belongs to another seat.`);
      }
      account.status = "ready";
      account.accountEmail = identity.accountEmail;
      if (identity.workspaceName)
        account.workspaceName = identity.workspaceName;
    },
    async markWebAccountNeedsSignIn({ webAccountId }) {
      accountById(webAccountId).status = "needs_sign_in";
    },
    async saveWebAccountProfile({ webAccountId, expectedProfileVersion }) {
      const account = accountById(webAccountId);
      if (account.profileVersion !== expectedProfileVersion) {
        return { status: "conflict", profileVersion: account.profileVersion };
      }
      // The profile itself stays with the caller: nothing here restores it.
      account.profileVersion += 1;
      return { status: "saved", profileVersion: account.profileVersion };
    },
    async reportWebSignInRequired({
      webAccountId,
      runId,
      iterationId,
      pendingStep,
      reason,
    }) {
      const account = accountById(webAccountId);
      let request = [...requests.values()].find(
        (open) => open.webAccountId === webAccountId && open.status === "open",
      );
      const shouldNotify = request === undefined;
      if (!request) {
        request = {
          requestId: randomUUID(),
          projectId: account.projectId,
          webAccountId,
          reason,
          status: "open",
          openedAt: now(),
          runs: [],
        };
        requests.set(request.requestId, request);
      }
      request.runs = [
        ...request.runs.filter((run) => run.runId !== runId),
        {
          runId,
          ...(iterationId ? { iterationId } : {}),
          pendingStep: structuredClone(pendingStep),
        },
      ];
      return { requestId: request.requestId, shouldNotify };
    },
    async markWebReconnectNotified({ requestId }) {
      const request = requests.get(requestId);
      if (request && !request.notifiedAt) request.notifiedAt = now();
    },
    async handbackWebReconnect({
      requestId,
      verifiedAccountEmail,
      verifiedWorkspace,
    }) {
      const request = requests.get(requestId);
      if (!request) return { status: "not_found" };
      if (request.status === "handed_back") {
        return { status: "already_handed_back" };
      }
      const expected = identityOf(accountById(request.webAccountId));
      const observed = {
        accountEmail: verifiedAccountEmail,
        ...(verifiedWorkspace ? { workspaceName: verifiedWorkspace } : {}),
      };
      if (!expected || !sameWebIdentity(expected, observed)) {
        return { status: "wrong_identity" };
      }
      request.status = "handed_back";
      return { status: "handed_back" };
    },
    async claimResumableWebRuns({ webAccountId }) {
      const claimed: ClaimedRun[] = [];
      for (const request of requests.values()) {
        if (request.webAccountId !== webAccountId) continue;
        if (request.status !== "handed_back") continue;
        for (const run of request.runs) {
          if (run.claimedAt) continue;
          run.claimedAt = now();
          claimed.push({
            requestId: request.requestId,
            runId: run.runId,
            ...(run.iterationId ? { iterationId: run.iterationId } : {}),
            pendingStep: structuredClone(run.pendingStep),
          });
        }
      }
      return claimed;
    },
    async listWebReconnectRequests({ projectId }) {
      return [...requests.values()]
        .filter((request) => request.projectId === projectId)
        .map((request) => structuredClone(request));
    },
  };
}

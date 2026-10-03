/**
 * The hosted keeper, one tick at a time, against a REAL events MCP server
 * (the SDK's official-server fixture) and a stub of the inbox Worker whose
 * public receiver the fixture's webhook deliveries actually reach.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { computeBindingKey } from "@mcpjam/sdk/events";
import {
  startEventsFixture,
  type EventsFixtureHandle,
} from "../../../../../sdk/tests/support/events-fixture.js";
import {
  StaleLeaseError,
  type EventSubscriptionRow,
  type SubscriptionClaimItem,
  type SubscriptionCommitRequest,
} from "../backend-client.js";
import { HttpInboxClient } from "../inbox-client.js";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors.js";
import {
  commitRequestFromOutcome,
  runKeeperTick,
  subscriptionRecordFromRow,
  type KeeperDeps,
} from "../keeper.js";
import {
  STUB_ADMIN_TOKEN,
  startInboxAdminStub,
  type InboxAdminStub,
} from "./support/inbox-admin-stub.js";

// Only the tests that leave `connect` to its default (connecting as the
// owner through `createAuthorizedManager`) reach these.
const authorizeMock = vi.hoisted(() => ({ createAuthorizedManager: vi.fn() }));
vi.mock("../../../routes/web/auth.js", () => authorizeMock);
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForDelegation: async () => "delegated-jwt",
}));

const SERVER_ID = "srv_events";

const opened: {
  fixtures: EventsFixtureHandle[];
  stubs: InboxAdminStub[];
  managers: MCPClientManager[];
} = { fixtures: [], stubs: [], managers: [] };

afterEach(async () => {
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  await Promise.all(opened.stubs.map((s) => s.close()));
  opened.fixtures = [];
  opened.stubs = [];
  opened.managers = [];
});

function row(overrides: Partial<EventSubscriptionRow> = {}): EventSubscriptionRow {
  return {
    _id: "k57subscriptiondoc",
    projectId: "proj_1",
    organizationId: "org_1",
    environmentId: null,
    ownerUserId: "user_doc_1",
    logicalId: "esub_keeper_1",
    binding: {
      serverId: SERVER_ID,
      credentialOwnerUserId: "user_doc_1",
      credentialFingerprint: null,
    },
    bindingKey: computeBindingKey({
      serverId: SERVER_ID,
      credentialOwnerUserId: "user_doc_1",
      credentialFingerprint: null,
    }),
    locality: "hosted",
    profile: "draft@28ec35e",
    eventName: "comment.created",
    arguments: { document_id: "doc_1" },
    mode: "webhook",
    desiredState: "active",
    observedState: "pending",
    generation: 4,
    nextActionAt: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function claim(subscription: EventSubscriptionRow): SubscriptionClaimItem {
  return {
    subscription,
    leaseToken: "lease_1",
    generation: subscription.generation,
    ownerExternalId: "user_workos_1",
    organizationId: "org_1",
  };
}

async function setup(subscription: EventSubscriptionRow) {
  const fixture = await startEventsFixture({ allowInsecureCallbacks: true });
  opened.fixtures.push(fixture);
  const stub = await startInboxAdminStub();
  opened.stubs.push(stub);
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(SERVER_ID, { url: fixture.url, timeout: 10_000 });

  const commits: SubscriptionCommitRequest[] = [];
  const backend = {
    claimSubscriptions: vi.fn(async () => [claim(subscription)]),
    commitSubscription: vi.fn(async (request: SubscriptionCommitRequest) => {
      commits.push(request);
      return { ok: true as const, generation: request.generation };
    }),
    ensureInbox: vi.fn(async () => ({ inboxId: stub.memory.inboxId })),
  };
  const connect = vi.fn(async () => ({
    rpc: {
      list: (params?: { cursor?: string }) => manager.listServerEvents(SERVER_ID, params),
      poll: (params: never) => manager.pollServerEvents(SERVER_ID, params),
      subscribe: (params: never) => manager.subscribeServerEvents(SERVER_ID, params),
      unsubscribe: (params: never) => manager.unsubscribeServerEvents(SERVER_ID, params),
    },
    close: vi.fn(async () => {}),
  }));
  const deps: KeeperDeps = {
    backend,
    connect,
    inboxFor: (inboxId) =>
      new HttpInboxClient({ inboxId, baseUrl: stub.url, adminToken: STUB_ADMIN_TOKEN }),
  };
  return { fixture, stub, manager, backend, connect, deps, commits };
}

describe("events keeper", () => {
  it("maps a registry row onto the coordinator's record", () => {
    const record = subscriptionRecordFromRow(
      row({ lastCursor: "c4", slotId: "slot_1", inboxId: "inbox_1" }),
      4,
    );
    expect(record).toMatchObject({
      id: "esub_keeper_1",
      serverId: SERVER_ID,
      environmentId: null,
      generation: 4,
      lastCursor: "c4",
      slotId: "slot_1",
      inboxId: "inbox_1",
    });
    expect(record).not.toHaveProperty("binding");
  });

  it("one tick subscribes a webhook row end to end and commits with CAS", async () => {
    const subscription = row();
    const { fixture, stub, deps, commits, backend } = await setup(subscription);
    const { claimed, results } = await runKeeperTick(deps, "inspector-test");
    expect(claimed).toBe(1);
    expect(results).toEqual(["committed"]);

    expect(backend.claimSubscriptions).toHaveBeenCalledWith({
      holder: "inspector-test",
      limit: 10,
      leaseMs: 60_000,
    });
    // The project's inbox was ensured (the row had none) and persisted.
    expect(backend.ensureInbox).toHaveBeenCalledWith("proj_1");
    const commit = commits[0]!;
    expect(commit).toMatchObject({
      subscriptionId: "k57subscriptiondoc",
      leaseToken: "lease_1",
      generation: 4,
      release: true,
    });
    expect(commit.patch).toMatchObject({
      observedState: "active",
      inboxId: stub.memory.inboxId,
      consecutiveFailures: 0,
    });
    expect(typeof commit.patch.nextActionAt).toBe("number");
    expect(commit.patch.callbackUrl).toMatch(
      new RegExp(`^${stub.url}/i/${stub.memory.inboxId}/s/`),
    );
    // Keys the step set to undefined are CLEARED, not sent as values.
    expect(commit.clear).toContain("lastError");
    expect(Object.values(commit.patch)).not.toContain(undefined);
    // No secret in anything the keeper commits.
    expect(JSON.stringify(commit)).not.toMatch(/whsec_/);

    // The server really holds a verified subscription at the slot's URL.
    const live = fixture.subscriptions();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ url: commit.patch.callbackUrl, verified: true });
    expect(commit.patch.serverSubscriptionId).toBe(live[0]!.id);

    // And an emitted event lands in the inbox journal through the receiver.
    await fixture.emit("comment.created", { document_id: "doc_1", comment_id: "c9", text: "hi" });
    await vi.waitFor(() =>
      expect(stub.memory.read(0).entries.map((entry) => entry.data?.comment_id)).toContain("c9"),
    );
  });

  it("swallows a stale (409) commit and reports it", async () => {
    const { deps, backend } = await setup(row({ mode: "poll" }));
    backend.commitSubscription.mockRejectedValueOnce(
      new StaleLeaseError("subscriptions/commit", "stale_generation"),
    );
    const { results } = await runKeeperTick(deps, "inspector-test");
    expect(results).toEqual(["stale"]);
  });

  it("polls a poll row and journals through the admin append", async () => {
    const { fixture, stub, deps, commits } = await setup(
      row({ mode: "poll", inboxId: undefined, lastCursor: "c0" }),
    );
    await fixture.emit("comment.created", { document_id: "doc_1", comment_id: "p1", text: "a" });
    await runKeeperTick(deps, "inspector-test");
    expect(commits[0]!.patch).toMatchObject({ observedState: "active", lastCursor: "c1" });
    expect(stub.memory.read(0).entries).toEqual([
      expect.objectContaining({ kind: "event", origin: "poll", logicalSubscriptionId: "esub_keeper_1" }),
    ]);
  });

  it("parks on lost authorization when connecting as the owner fails", async () => {
    const { deps, commits } = await setup(row({ mode: "poll" }));
    deps.connect = async () => {
      throw Object.assign(new Error("Unauthorized"), { name: "UnauthorizedError" });
    };
    await runKeeperTick(deps, "inspector-test");
    expect(commits[0]!.patch).toMatchObject({
      observedState: "paused_auth",
      lastError: expect.objectContaining({ kind: "authorization_lost", retryable: false }),
    });
  });

  it("connects with the subscription's pinned OAuth connection, and parks when it is refused", async () => {
    const { deps, commits } = await setup(
      row({ mode: "poll", oauthConnectionId: "conn_A" }),
    );
    delete deps.connect;
    // The pinned connection is gone: authorize has no token for it and
    // refuses, instead of resolving the owner's new default.
    authorizeMock.createAuthorizedManager.mockRejectedValueOnce(
      new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        'Server "events" requires OAuth authentication. Please complete the OAuth flow first.',
        { oauthRequired: true },
      ),
    );
    await runKeeperTick(deps, "inspector-test");
    expect(authorizeMock.createAuthorizedManager).toHaveBeenCalledTimes(1);
    expect(authorizeMock.createAuthorizedManager.mock.calls[0]![7]).toEqual({
      connectionIds: { [SERVER_ID]: "conn_A" },
    });
    expect(commits[0]!.patch).toMatchObject({
      observedState: "paused_auth",
      lastError: expect.objectContaining({ kind: "authorization_lost", retryable: false }),
    });
  });

  it("builds the commit body: defined fields patched, undefined ones cleared", () => {
    const request = commitRequestFromOutcome(
      claim(row()),
      {
        patch: {
          observedState: "paused",
          serverSubscriptionId: undefined,
          consecutiveFailures: 0,
          lastError: undefined,
        },
        nextActionAt: 123,
      },
    );
    expect(request.patch).toEqual({ observedState: "paused", consecutiveFailures: 0, nextActionAt: 123 });
    expect(request.clear).toEqual(["serverSubscriptionId", "lastError"]);
  });
});

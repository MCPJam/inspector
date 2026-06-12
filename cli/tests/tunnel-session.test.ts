import assert from "node:assert/strict";
import test from "node:test";
import type { CreateTunnelResult } from "@mcpjam/sdk/platform";
import {
  TunnelSession,
  type LocalBridgeLike,
  type RelayConnectionLike,
  type TunnelSessionDeps,
  type TunnelSessionResult,
} from "../src/lib/tunnel/tunnel-session.js";

function makeGrantResult(secretVersion = 1): CreateTunnelResult {
  return {
    project: { id: "proj-1", name: "Proj", organizationId: "org-1" },
    grant: {
      serverId: "srv-1",
      name: "everything",
      existed: false,
      slug: "calm-otter",
      url: `https://calm-otter.tunnels.example.com/api/mcp/adapter-http/srv-1?k=s${secretVersion}`,
      connectToken: `ct-${secretVersion}`,
      relayWsUrl: "wss://relay.example.com/agent",
      secretVersion,
    },
  };
}

class StubConnection implements RelayConnectionLike {
  permanentFailure: string | null = null;
  closed = false;
  constructor(
    readonly onPermanentFailure: (reason: string, closeCode: number) => void,
    private readonly behavior: {
      failOnConnect?: string;
      // Simulates a permanent close racing the handshake: the callback
      // fires mid-dial but connect() still resolves and permanentFailure
      // stays unset — only the session's stash can catch it.
      fireHandlerOnConnect?: { reason: string; closeCode: number };
    } = {},
  ) {}

  async connect(): Promise<void> {
    if (this.behavior.failOnConnect) {
      this.permanentFailure = this.behavior.failOnConnect;
      throw new Error(this.behavior.failOnConnect);
    }
    if (this.behavior.fireHandlerOnConnect) {
      const { reason, closeCode } = this.behavior.fireHandlerOnConnect;
      this.onPermanentFailure(reason, closeCode);
    }
  }

  close(): void {
    this.closed = true;
  }
}

type Harness = {
  session: TunnelSession;
  connections: StubConnection[];
  createGrantCalls: number;
  closeGrantCalls: CreateTunnelResult[];
  bridge: { closed: boolean } & LocalBridgeLike;
  grants: Array<{ result: CreateTunnelResult; rotated: boolean }>;
  logs: string[];
  /** Fire a permanent close on the most recent connection. */
  firePermanent(reason: string, code: number): void;
};

function makeHarness(
  overrides: Partial<TunnelSessionDeps> & {
    connectionBehavior?: {
      failOnConnect?: string;
      fireHandlerOnConnect?: { reason: string; closeCode: number };
    };
  } = {},
): Harness {
  const connections: StubConnection[] = [];
  const closeGrantCalls: CreateTunnelResult[] = [];
  const grants: Array<{ result: CreateTunnelResult; rotated: boolean }> = [];
  const logs: string[] = [];
  const bridge = {
    localAddr: "http://127.0.0.1:1234",
    closed: false,
    async close() {
      this.closed = true;
    },
  };
  const state = { createGrantCalls: 0 };

  const deps: TunnelSessionDeps = {
    createGrant: async () => {
      state.createGrantCalls += 1;
      return makeGrantResult(state.createGrantCalls);
    },
    closeGrant: async (result) => {
      closeGrantCalls.push(result);
    },
    startBridge: async () => bridge,
    connectRelay: ({ onPermanentFailure }) => {
      const connection = new StubConnection(
        onPermanentFailure,
        overrides.connectionBehavior ?? {},
      );
      connections.push(connection);
      return connection;
    },
    log: (message) => logs.push(message),
    onGrant: (result, rotated) => grants.push({ result, rotated }),
    now: () => 1_000_000,
    ...overrides,
  };

  const session = new TunnelSession(deps);
  return {
    session,
    connections,
    get createGrantCalls() {
      return state.createGrantCalls;
    },
    closeGrantCalls,
    bridge,
    grants,
    logs,
    firePermanent(reason, code) {
      connections[connections.length - 1]!.onPermanentFailure(reason, code);
    },
  };
}

async function settledWithin(
  session: TunnelSession,
  ms = 100,
): Promise<TunnelSessionResult | null> {
  return Promise.race([
    session.waitUntilClosed(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function waitFor(predicate: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("start creates the grant, starts the bridge, connects, and reports the grant", async () => {
  const harness = makeHarness();

  const result = await harness.session.start();

  assert.equal(result.grant.serverId, "srv-1");
  assert.equal(harness.createGrantCalls, 1);
  assert.equal(harness.connections.length, 1);
  assert.deepEqual(
    harness.grants.map((entry) => entry.rotated),
    [false],
  );
  assert.equal(await settledWithin(harness.session), null);
  await harness.session.stop();
});

test("start applies the handshake-race guard: a permanent close between hello and registration fails startup", async () => {
  const harness = makeHarness({
    connectionBehavior: { failOnConnect: "dead before registration" },
  });

  await assert.rejects(
    () => harness.session.start(),
    /dead before registration/,
  );
  assert.equal(harness.bridge.closed, true);
  assert.equal(harness.connections[0]!.closed, true);
  // The minted grant's secret must not stay live for a session that never
  // came up.
  assert.equal(harness.closeGrantCalls.length, 1);
});

test("close 4000 remints: new grant, new connection, rotated onGrant, session stays up", async () => {
  const harness = makeHarness();
  await harness.session.start();

  harness.firePermanent("expired", 4000);
  await waitFor(() => harness.grants.length === 2);

  assert.equal(harness.createGrantCalls, 2);
  assert.equal(harness.connections.length, 2);
  assert.equal(harness.connections[0]!.closed, true);
  assert.deepEqual(harness.grants[1]!.rotated, true);
  assert.equal(harness.grants[1]!.result.grant.connectToken, "ct-2");
  assert.equal(await settledWithin(harness.session), null);
  await harness.session.stop();
});

test("rapid-fire 4000 loops hit the remint cap and exit 1", async () => {
  // Fixed clock: every remint counts as rapid, so the window reset never
  // applies and the 4th attempt exceeds the cap.
  const harness = makeHarness();
  await harness.session.start();

  for (let round = 0; round < 3; round += 1) {
    const before = harness.grants.length;
    harness.firePermanent("expired", 4000);
    await waitFor(() => harness.grants.length === before + 1);
  }
  harness.firePermanent("expired", 4000);

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /could not be renewed/);
  assert.equal(harness.createGrantCalls, 4);
  assert.equal(harness.bridge.closed, true);
});

test("a failing remint settles the session with the failure reason", async () => {
  let calls = 0;
  const harness = makeHarness({
    createGrant: async () => {
      calls += 1;
      if (calls > 1) throw new Error("backend says no");
      return makeGrantResult(calls);
    },
  });
  await harness.session.start();

  harness.firePermanent("expired", 4000);

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /backend says no/);
});

test("close 4001 exits 1 with the takeover message", async () => {
  const harness = makeHarness();
  await harness.session.start();

  harness.firePermanent("replaced", 4001);

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /taken over/i);
  assert.equal(harness.bridge.closed, true);
});

test("close 4002 exits 1 covering both takeover-by-mint and remote close", async () => {
  const harness = makeHarness();
  await harness.session.start();

  harness.firePermanent("revoked", 4002);

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 1);
  assert.match(result.reason ?? "", /closed or re-created elsewhere/i);
});

test("stop closes the relay and bridge, revokes the grant, and exits 0", async () => {
  const harness = makeHarness();
  await harness.session.start();

  await harness.session.stop();

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 0);
  assert.equal(harness.connections[0]!.closed, true);
  assert.equal(harness.bridge.closed, true);
  assert.equal(harness.closeGrantCalls.length, 1);
  assert.equal(harness.closeGrantCalls[0]!.grant.serverId, "srv-1");
});

test("stop still exits 0 when grant revocation fails, and says so", async () => {
  const harness = makeHarness({
    closeGrant: async () => {
      throw new Error("backend unreachable");
    },
  });
  await harness.session.start();

  await harness.session.stop();

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 0);
  assert.ok(
    harness.logs.some((line) => line.includes("Could not revoke")),
    `expected a revoke warning in: ${JSON.stringify(harness.logs)}`,
  );
});

test("a permanent close that races the handshake fails startup instead of reporting a dead tunnel", async () => {
  // The callback fires mid-dial without permanentFailure being set: only
  // the stashed-event path can catch this one.
  const harness = makeHarness({
    connectionBehavior: {
      fireHandlerOnConnect: { reason: "revoked mid-handshake", closeCode: 4002 },
    },
  });

  await assert.rejects(() => harness.session.start(), /revoked mid-handshake/);
  assert.equal(harness.grants.length, 0);
  assert.equal(harness.bridge.closed, true);
  assert.equal(harness.connections[0]!.closed, true);
});

test("a second 4000 during an in-flight remint does not start a parallel rotation", async () => {
  let resolveSecondGrant: ((result: CreateTunnelResult) => void) | undefined;
  let calls = 0;
  const harness = makeHarness({
    createGrant: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(makeGrantResult(1));
      return new Promise<CreateTunnelResult>((resolve) => {
        resolveSecondGrant = resolve;
      });
    },
  });
  await harness.session.start();

  harness.firePermanent("expired", 4000);
  await waitFor(() => calls === 2);
  // The remint is parked on createGrant; a second 4000 must be dropped,
  // not rotate a competing grant.
  harness.firePermanent("expired", 4000);
  resolveSecondGrant!(makeGrantResult(2));
  await waitFor(() => harness.grants.length === 2);

  assert.equal(calls, 2);
  assert.equal(harness.grants[1]!.rotated, true);
  assert.equal(await settledWithin(harness.session), null);
  await harness.session.stop();
});

test("stop aborts a hung grant revocation after the grace period and still exits 0", async () => {
  let observedAbort = false;
  const harness = makeHarness({
    closeGrantTimeoutMs: 25,
    closeGrant: (_result, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("aborted"));
        });
      }),
  });
  await harness.session.start();

  await harness.session.stop();

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 0);
  await waitFor(() => observedAbort);
  assert.ok(
    harness.logs.some((line) => line.includes("Could not revoke")),
    `expected a revoke warning in: ${JSON.stringify(harness.logs)}`,
  );
});

test("stop during an in-flight remint revokes the freshly minted grant", async () => {
  let resolveSecondGrant: ((result: CreateTunnelResult) => void) | undefined;
  let calls = 0;
  const harness = makeHarness({
    createGrant: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(makeGrantResult(1));
      return new Promise<CreateTunnelResult>((resolve) => {
        resolveSecondGrant = resolve;
      });
    },
  });
  await harness.session.start();

  harness.firePermanent("expired", 4000);
  await waitFor(() => calls === 2);
  // Ctrl-C completes while the rotation's mint is still in flight; its
  // revocation may have raced ahead of the mint at the backend.
  await harness.session.stop();
  assert.equal(harness.closeGrantCalls.length, 1);
  assert.equal(harness.closeGrantCalls[0]!.grant.connectToken, "ct-1");

  resolveSecondGrant!(makeGrantResult(2));
  await waitFor(() => harness.closeGrantCalls.length === 2);

  // The post-stop mint got revoked too, and no new relay was dialed.
  assert.equal(harness.closeGrantCalls[1]!.grant.connectToken, "ct-2");
  assert.equal(harness.connections.length, 1);
  assert.equal(harness.grants.length, 1);
  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 0);
});

test("permanent closes after stop are ignored", async () => {
  const harness = makeHarness();
  await harness.session.start();
  await harness.session.stop();

  harness.firePermanent("revoked", 4002);

  const result = await harness.session.waitUntilClosed();
  assert.equal(result.exitCode, 0);
});

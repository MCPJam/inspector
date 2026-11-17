import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPluginControlStore } from "../local-store.js";
import {
  INVOCATION_RECEIPT_PATH,
  PLUGIN_INSTANCE_CONTROL_PATH,
} from "../../../../shared/plugin-invocation-receipts.js";

/**
 * Hosted replicas share no memory and have no sticky routing, so "send to a
 * new chat" can prepare on one replica and start the chat on another. Each
 * replica here is a fresh module graph. All they share is the durable layer
 * behind the service URL: the control store, kept by the local store under
 * the backend's rules, and receipt claims modelled on the backend's (the
 * first fingerprint wins, and an expired owner row refuses every claim).
 */
type Command = Record<string, any> & { action: string };
function durableLayer() {
  const controls = new LocalPluginControlStore();
  const control = controls.handler(
    PLUGIN_INSTANCE_CONTROL_PATH,
    "INSTANCE_STORE_UNAVAILABLE",
  );
  const owners = new Map<
    string,
    { identityHash: string; controlHash: string }
  >();
  const receipts = new Map<
    string,
    { ownerHash: string; fingerprint: string }
  >();
  const state = { down: false, claims: 0 };
  const signal = new AbortController().signal;
  const handle = async (path: string, c: Command) => {
    if (path === PLUGIN_INSTANCE_CONTROL_PATH) {
      if (c.action === "issue")
        owners.set(c.ownerHash, {
          identityHash: c.identityHash,
          controlHash: c.controlHash,
        });
      return control(c, signal);
    }
    if (path !== INVOCATION_RECEIPT_PATH || c.action !== "claim")
      throw Object.assign(new Error(), { code: "UNEXPECTED" });
    state.claims++;
    const owner = owners.get(c.ownerHash);
    if (owner) await control({ action: "read", ...owner }, signal);
    const row = receipts.get(c.scopeHash);
    if (!row) {
      receipts.set(c.scopeHash, {
        ownerHash: c.ownerHash,
        fingerprint: c.fingerprint,
      });
      return { claimed: true, receipt: {} };
    }
    if (row.ownerHash !== c.ownerHash || row.fingerprint !== c.fingerprint)
      throw Object.assign(new Error(), { code: "INVOCATION_ID_REUSED" });
    return { claimed: false, receipt: {} };
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (state.down) throw new Error("connection refused");
    try {
      const value = await handle(
        new URL(url).pathname,
        JSON.parse(String(init.body)),
      );
      return new Response(JSON.stringify(value), { status: 200 });
    } catch (error) {
      return new Response(
        JSON.stringify({ code: (error as { code?: string }).code }),
        { status: 409 },
      );
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

const env = {
  INSPECTOR_SERVICE_TOKEN: "service-token-for-tests",
  CONVEX_HTTP_URL: "https://durable.test",
};
let layer: ReturnType<typeof durableLayer>;
/** A replica: its own module graph over the shared durable layer. */
async function replica() {
  vi.resetModules();
  const { messagePreparationStore } =
    await import("../message-preparation-store.js");
  return messagePreparationStore({
    env,
    hosted: true,
    fetchImpl: layer.fetchImpl,
  });
}
const record = {
  actorId: "actor",
  projectId: "project",
  subject: "subject",
  hostId: "host",
  serverId: "server",
  toolName: "tool",
  revision: "revision",
  intentDigest: "digest",
};
const identity = {
  actorId: "actor",
  projectId: "project",
  subject: "subject",
  hostId: "host",
  intentDigest: "digest",
};
const signal = new AbortController().signal;
const UNAVAILABLE = { code: "INSTANCE_MESSAGE_UNAVAILABLE" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  layer = durableLayer();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("new-chat message preparations across replicas", () => {
  it("prepares on one replica and reads and binds on another", async () => {
    const [first, second, third] = [
      await replica(),
      await replica(),
      await replica(),
    ];
    const token = await first.issue(record, signal);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await second.read(token, identity, signal)).toEqual(record);
    await second.bind(token, identity, "destination", signal);
    // The same destination may bind again, on any replica.
    await third.bind(token, identity, "destination", signal);
    await first.bind(token, identity, "destination", signal);
  });

  it("refuses a second destination on every replica", async () => {
    const [first, second] = [await replica(), await replica()];
    const token = await first.issue(record, signal);
    await second.bind(token, identity, "destination", signal);
    await expect(
      first.bind(token, identity, "other", signal),
    ).rejects.toMatchObject(UNAVAILABLE);
    await expect(
      second.bind(token, identity, "other", signal),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it("lets exactly one of two racing destinations bind", async () => {
    const [first, second, third] = [
      await replica(),
      await replica(),
      await replica(),
    ];
    const token = await first.issue(record, signal);
    const results = await Promise.allSettled([
      second.bind(token, identity, "one", signal),
      third.bind(token, identity, "two", signal),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("expires after 60 seconds for reads and binds", async () => {
    const [first, second] = [await replica(), await replica()];
    const token = await first.issue(record, signal);
    vi.setSystemTime(1_000_000 + 59_999);
    await second.read(token, identity, signal);
    vi.setSystemTime(1_000_000 + 60_000);
    await expect(second.read(token, identity, signal)).rejects.toMatchObject(
      UNAVAILABLE,
    );
    await expect(
      second.bind(token, identity, "destination", signal),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it("refuses an expired preparation that was bound before it expired", async () => {
    const [first, second] = [await replica(), await replica()];
    const token = await first.issue(record, signal);
    await second.bind(token, identity, "destination", signal);
    vi.setSystemTime(1_000_000 + 60_000);
    await expect(
      first.bind(token, identity, "destination", signal),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it.each([
    "actorId",
    "projectId",
    "subject",
    "hostId",
    "intentDigest",
  ] as const)(
    "shows another %s nothing, and leaves the owner's bind intact",
    async (key) => {
      const [first, second] = [await replica(), await replica()];
      const token = await first.issue(record, signal);
      const other = { ...identity, [key]: "other" };
      await expect(second.read(token, other, signal)).rejects.toMatchObject(
        UNAVAILABLE,
      );
      await expect(
        second.bind(token, other, "intruder", signal),
      ).rejects.toMatchObject(UNAVAILABLE);
      await second.bind(token, identity, "destination", signal);
    },
  );

  it("refuses a token that was never prepared", async () => {
    const store = await replica();
    await expect(
      store.read("a".repeat(43), identity, signal),
    ).rejects.toMatchObject(UNAVAILABLE);
    await expect(
      store.bind("a".repeat(43), identity, "destination", signal),
    ).rejects.toMatchObject(UNAVAILABLE);
    expect(layer.state.claims).toBe(0);
  });

  it("caps live preparations per identity", async () => {
    const store = await replica();
    for (let i = 0; i < 512; i++)
      await store.issue({ ...record, intentDigest: String(i) }, signal);
    await expect(store.issue(record, signal)).rejects.toMatchObject({
      code: "INSTANCE_LIMIT",
    });
    // Another identity has its own slots.
    await store.issue({ ...record, actorId: "someone-else" }, signal);
    vi.setSystemTime(1_000_000 + 60_000);
    await store.issue(record, signal);
  });

  it("fails closed when the durable store is unreachable", async () => {
    const [first, second] = [await replica(), await replica()];
    const token = await first.issue(record, signal);
    layer.state.down = true;
    await expect(first.issue(record, signal)).rejects.toMatchObject({
      code: "INSTANCE_STORE_UNAVAILABLE",
    });
    await expect(second.read(token, identity, signal)).rejects.toMatchObject({
      code: "INSTANCE_STORE_UNAVAILABLE",
    });
  });

  it("keeps local installs in process, without the durable layer", async () => {
    vi.resetModules();
    const { messagePreparationStore } =
      await import("../message-preparation-store.js");
    const { MessagePreparations } = await import("../message-preparations.js");
    const fetchImpl = vi.fn();
    const store = messagePreparationStore({
      env: {},
      hosted: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(store).toBeInstanceOf(MessagePreparations);
    const token = await store.issue(record, signal);
    await store.bind(token, identity, "destination", signal);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  ResourceGrantService,
  type BoundResourceAdapter,
  type ResourceOwner,
} from "../resource-grants.js";

const owner: ResourceOwner = {
  actorId: "actor",
  projectId: "project",
  subject: "verified-subject",
  workspaceId: "workspace",
  instanceId: "instance",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
};
const bytes = (value: string) => new TextEncoder().encode(value);

/** Exclusive managed resource; compare-and-replace occurs without an await. */
function managedAdapter(initial = "original") {
  let content = bytes(initial);
  let version = 1;
  const listeners = new Set<() => void>();
  const adapter: BoundResourceAdapter = {
    read: vi.fn(async () => ({ bytes: content.slice(), etag: `v${version}` })),
    conditionalWrite: vi.fn(async (_key, next, ifMatch, signal) => {
      signal.throwIfAborted();
      if (ifMatch !== undefined && ifMatch !== `v${version}`)
        return { outcome: "conflict" as const, etag: `v${version}` };
      content = next.slice();
      version++;
      for (const listener of listeners) listener();
      return { outcome: "saved" as const, etag: `v${version}` };
    }),
    watch: vi.fn(async (_key, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return { adapter, listeners };
}

function setup(
  adapter: BoundResourceAdapter,
  authorize = vi.fn(async () => {}),
) {
  let id = 0;
  const service = new ResourceGrantService({
    authorize,
    maxBytes: 20,
    mintId: () => `fixture-${++id}`,
  });
  const { resourceUri: uri } = service.open(owner, {
    key: "trusted-key",
    adapter,
    privatePath: "/disposable/only/fixture.txt",
  });
  return { service, uri, authorize };
}

describe("instance-owned resource grants", () => {
  it("requires an owned read advertising writes and atomically conflicts simultaneous writes", async () => {
    const { adapter } = managedAdapter();
    const { service, uri } = setup(adapter);
    await expect(
      service.write(owner, { uri, text: "before read" }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    const read = await service.read(owner, { uri });
    expect(read.contents[0]._meta).toEqual({
      "openai/resource": { writable: true, etag: "v1" },
    });
    const results = await Promise.all([
      service.write(owner, { uri, text: "one", ifMatch: "v1" }),
      service.write(owner, { uri, text: "two", ifMatch: "v1" }),
    ]);
    expect(results).toEqual([
      { outcome: "saved", etag: "v2" },
      { outcome: "conflict", etag: "v2" },
    ]);
    expect((await service.read(owner, { uri })).contents[0]).toMatchObject({
      text: "one",
    });
  });

  it("rejects every foreign owner dimension and never invokes the adapter", async () => {
    const { adapter } = managedAdapter();
    const { service, uri } = setup(adapter);
    for (const key of [
      "workspaceId",
      "instanceId",
      "generation",
      "serverId",
      "bindingId",
    ] as const) {
      const foreign = { ...owner, [key]: key === "generation" ? 2 : "foreign" };
      await expect(service.read(foreign, { uri })).rejects.toMatchObject({
        code: "RESOURCE_DENIED",
      });
      await expect(service.toolMetadata(foreign, uri)).rejects.toMatchObject({
        code: "RESOURCE_DENIED",
      });
    }
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it("keeps ordinary filesystem adapters read-only and confines metadata authority", async () => {
    const { adapter } = managedAdapter();
    delete adapter.conditionalWrite;
    const { service, uri } = setup(adapter);
    expect(
      (await service.read(owner, { uri })).contents[0]._meta["openai/resource"]
        .writable,
    ).toBe(false);
    await expect(
      service.write(owner, { uri, text: "x" }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(
      await service.toolMetadata(owner, uri, {
        "openai/resource.path": "/personal/forged",
        "openai/resource": { path: "/nested/forged", custom: { keep: true } },
        opaque: { keep: true },
      }),
    ).toEqual({
      "openai/resource": {
        path: "/disposable/only/fixture.txt",
        custom: { keep: true },
      },
      opaque: { keep: true },
    });
    expect(
      JSON.stringify(service.open(owner, { key: "private-path", adapter })),
    ).not.toContain("private-path");
  });

  it("never forwards a requested path when the host grant has no path mapping", async () => {
    const { adapter } = managedAdapter();
    const { service } = setup(adapter);
    const { resourceUri } = service.open(owner, { key: "pathless", adapter });
    expect(
      await service.toolMetadata(owner, resourceUri, {
        "openai/resource.path": "/fixture/flat-forgery",
        "openai/resource": { path: "/fixture/nested-forgery" },
        opaque: { keep: true },
      }),
    ).toEqual({ opaque: { keep: true } });
    service.dispose();
  });

  it("bounds decoded blob and UTF-8 sizes before writing and validates representations", async () => {
    const { adapter } = managedAdapter();
    const { service, uri } = setup(adapter);
    await service.read(owner, { uri });
    expect(await service.write(owner, { uri, text: "😀".repeat(6) })).toEqual({
      outcome: "too-large",
      maxBytes: 20,
    });
    expect(
      await service.write(owner, {
        uri,
        blob: Buffer.alloc(21).toString("base64"),
      }),
    ).toEqual({ outcome: "too-large", maxBytes: 20 });
    await expect(
      service.write(owner, { uri, blob: "malformed!" }),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    await expect(
      service.write(owner, { uri, text: "x", blob: "" }),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    expect(adapter.conditionalWrite).not.toHaveBeenCalled();
    await service.write(owner, { uri, blob: "/w==" });
    expect((await service.read(owner, { uri })).contents[0]).toMatchObject({
      blob: "/w==",
    });
    await expect(
      service.read(owner, { uri, representation: "text" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_TEXT" });
  });

  it("revalidates authority and discards late reads after revocation", async () => {
    let finish!: (value: { bytes: Uint8Array; etag: string }) => void;
    const adapter: BoundResourceAdapter = {
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const { service, uri } = setup(adapter);
    const pending = service.read(owner, { uri });
    await vi.waitFor(() => expect(finish).toBeDefined());
    service.closeBinding(owner.bindingId);
    finish({ bytes: bytes("late"), etag: "v1" });
    await expect(pending).rejects.toThrow();
    const denied = setup(
      managedAdapter().adapter,
      vi.fn(async () => {
        throw new Error("revoked bearer");
      }),
    );
    await expect(
      denied.service.read(owner, { uri: denied.uri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    await expect(
      denied.service.read(owner, { uri: denied.uri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(denied.authorize).toHaveBeenCalledTimes(1);
  });

  it("reports uncertain write outcomes without retrying the effect", async () => {
    const { adapter } = managedAdapter();
    const { service, uri } = setup(adapter);
    await service.read(owner, { uri });
    adapter.conditionalWrite = vi.fn(async () => {
      service.revoke(uri);
      return { outcome: "saved" as const, etag: "v2" };
    });
    await expect(
      service.write(owner, { uri, text: "changed" }),
    ).rejects.toMatchObject({ code: "RESOURCE_OUTCOME_UNKNOWN" });
    expect(adapter.conditionalWrite).toHaveBeenCalledTimes(1);
  });

  it("coalesces watches, removes them on close and rejects queued notifications after unsubscribe", async () => {
    const { adapter, listeners } = managedAdapter();
    const { service, uri } = setup(adapter);
    const changed = vi.fn();
    await Promise.all([
      service.subscribe(owner, uri, changed),
      service.subscribe(owner, uri, changed),
    ]);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener();
      listener();
      listener();
    }
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    changed.mockClear();
    for (const listener of listeners) listener();
    await service.unsubscribe(owner, uri);
    await new Promise((resolve) => setImmediate(resolve));
    expect(changed).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    await service.subscribe(owner, uri, changed);
    service.closeInstance(owner.instanceId);
    expect(listeners.size).toBe(0);
  });

  it("cleans up a watch that finishes installing after its instance closed", async () => {
    let finish!: (stop: () => void) => void;
    const { adapter } = managedAdapter();
    adapter.watch = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const { service, uri } = setup(adapter);
    const pending = service.subscribe(owner, uri, vi.fn());
    await vi.waitFor(() => expect(finish).toBeDefined());
    service.dispose();
    const stop = vi.fn();
    finish(stop);
    await expect(pending).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("revokes every owned grant even if one watch cleanup throws", async () => {
    const { adapter } = managedAdapter();
    let calls = 0;
    const stop = vi.fn(() => {
      if (++calls === 1) throw new Error("watch failed to stop");
    });
    adapter.watch = async () => stop;
    const { service, uri } = setup(adapter);
    const other = service.open(owner, { key: "other", adapter }).resourceUri;
    await service.subscribe(owner, uri, vi.fn());
    await service.subscribe(owner, other, vi.fn());
    expect(() => service.closeInstance(owner.instanceId)).toThrow(
      "Resource cleanup failed",
    );
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(service.read(owner, { uri })).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    await expect(service.read(owner, { uri: other })).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
  });
});

describe("credential-scoped expiring resource grants", () => {
  it.each(["actorId", "projectId", "subject"] as const)(
    "refuses a different %s before reading or revealing metadata",
    async (field) => {
      const { adapter } = managedAdapter();
      const { service, uri } = setup(adapter);
      const foreign = { ...owner, [field]: "other" };
      await expect(service.read(foreign, { uri })).rejects.toMatchObject({
        code: "RESOURCE_DENIED",
      });
      await expect(service.toolMetadata(foreign, uri)).rejects.toMatchObject({
        code: "RESOURCE_DENIED",
      });
      expect(adapter.read).not.toHaveBeenCalled();
      service.dispose();
    },
  );

  it("requires complete trusted identity and a future bounded expiry", () => {
    const { adapter } = managedAdapter();
    const service = new ResourceGrantService({
      authorize: async () => {},
      maxBytes: 100,
      now: () => 100,
      maxAgeMs: 10,
    });
    expect(() =>
      service.open({ ...owner, subject: "" }, { adapter, key: "a" }),
    ).toThrow("RESOURCE_DENIED");
    expect(() =>
      service.open(owner, { adapter, key: "a", expiresAt: 100 }),
    ).toThrow("RESOURCE_DENIED");
    expect(() =>
      service.open(owner, { adapter, key: "a", expiresAt: NaN }),
    ).toThrow("RESOURCE_DENIED");
    service.dispose();
  });

  it("expires after authorization and after an ignored-abort read without delivering bytes", async () => {
    let now = 100;
    const { adapter } = managedAdapter();
    const service = new ResourceGrantService({
      authorize: async () => {},
      maxBytes: 100,
      now: () => now,
      maxAgeMs: 10,
    });
    const { resourceUri: uri } = service.open(owner, {
      adapter,
      key: "a",
      expiresAt: 1_000_000,
    });
    vi.mocked(adapter.read).mockImplementationOnce(async () => {
      now = 110;
      return { bytes: bytes("private"), etag: "v1" };
    });
    await expect(service.read(owner, { uri })).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    await expect(service.subscribe(owner, uri, () => {})).rejects.toMatchObject(
      { code: "RESOURCE_DENIED" },
    );
    expect(adapter.watch).not.toHaveBeenCalled();
    service.dispose();
  });

  it("removes subscriptions on expiry and reclaims capacity", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, listeners } = managedAdapter();
      const changed = vi.fn();
      const service = new ResourceGrantService({
        authorize: async () => {},
        maxBytes: 100,
        maxGrants: 1,
        maxAgeMs: 10,
      });
      const { resourceUri: uri } = service.open(owner, { adapter, key: "a" });
      await service.subscribe(owner, uri, changed);
      expect(listeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(listeners.size).toBe(0);
      expect(changed).not.toHaveBeenCalled();
      expect(() => service.open(owner, { adapter, key: "b" })).not.toThrow();
      await expect(
        service.write(owner, { uri, text: "late", ifMatch: "v1" }),
      ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
      expect(adapter.conditionalWrite).not.toHaveBeenCalled();
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

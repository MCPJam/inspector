import { describe, expect, it, vi } from "vitest";
import { managedResourceFixture } from "../testing/managed-resource-fixture.js";
import { createPluginFileResourceSession } from "../file-resource-session.js";
import {
  pluginFileEntrypointPlan,
  parsePluginFileInput,
} from "../../../../shared/plugin-file.js";

function fixture() {
  const abort = new AbortController();
  let allowed = true;
  let live = true;
  const adapter = {
    read: vi.fn(async () => ({
      bytes: new TextEncoder().encode("café\n"),
      etag: "opaque",
    })),
  };
  const authorize = vi.fn(async () => {
    if (!allowed) throw new Error("revoked");
  });
  const options = {
    owner: {
      actorId: "actor",
      projectId: "project",
      subject: "verified-subject",
      workspaceId: "workspace",
      instanceId: "app",
      generation: 1,
      serverId: "server",
      bindingId: "target",
    },
    resource: {
      key: "private-key",
      name: "bolt.step",
      privatePath: "/disposable/bolt.step",
      maxBytes: 32,
      adapter,
    },
    signal: abort.signal,
    authorize,
    assertLive: () => {
      if (!live) throw new Error("closed");
    },
  };
  const session = createPluginFileResourceSession(options);
  return {
    session,
    options,
    abort,
    authorize,
    adapter,
    revoke: () => {
      allowed = false;
    },
    closeOwner: () => {
      live = false;
    },
  };
}

describe("owned file resource session", () => {
  it("reconstructs only a read-only host-derived original grant with fresh authorization", async () => {
    const f = fixture();
    f.session.close();
    const options = { ...f.options, resourceId: "a".repeat(64) };
    const first = createPluginFileResourceSession(options);
    first.close();
    const restored = createPluginFileResourceSession(options);
    options.resourceId = "b".repeat(64);
    expect(restored.input).toEqual(first.input);
    expect(restored.capabilities).toEqual({ write: false, subscribe: false });
    expect(
      (await restored.read({ uri: first.input.file.resourceUri })).contents[0],
    ).toMatchObject({ text: "café\n" });
    f.revoke();
    await expect(
      restored.read({ uri: first.input.file.resourceUri }),
    ).rejects.toThrow();
    expect(f.adapter.read).toHaveBeenCalledOnce();
    restored.close();
  });
  it.each(["invalid-id", "write", "watch"] as const)(
    "refuses %s recovery instead of restoring volatile effects",
    (kind) => {
      const f = fixture();
      f.session.close();
      const managed = managedResourceFixture();
      expect(() =>
        createPluginFileResourceSession({
          ...f.options,
          resourceId: kind === "invalid-id" ? "forged" : "a".repeat(64),
          resource: {
            ...f.options.resource,
            adapter:
              kind === "write"
                ? {
                    read: managed.adapter.read,
                    conditionalWrite: managed.adapter.conditionalWrite,
                  }
                : kind === "watch"
                  ? managed.adapter
                  : f.adapter,
            ...(kind === "write" ? { authorizeWrite: async () => {} } : {}),
          },
        }),
      ).toThrow("PLUGIN_FILE_RECOVERY_UNSUPPORTED");
      expect(managed.writes()).toBe(0);
      expect(managed.listeners.size).toBe(0);
    },
  );
  it("uses the official FileInput and declaration without disclosing the private mapping", async () => {
    const f = fixture();
    const tool = {
      name: "viewer",
      _meta: {
        "openai/ui": { entrypoints: [{ type: "file", extensions: [".step"] }] },
      },
    };
    const plan = pluginFileEntrypointPlan(tool, f.session.input);
    expect(plan).toEqual({
      params: { name: "viewer", arguments: f.session.input },
      scope: { kind: "global" },
    });
    const result = await f.session.read({
      uri: f.session.input.file.resourceUri,
      _meta: { "openai/resource": { representation: "blob" }, unrelated: [1] },
    });
    expect(result.contents[0]).toMatchObject({
      blob: Buffer.from("café\n").toString("base64"),
      _meta: { "openai/resource": { etag: "opaque", writable: false } },
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([plan, result])).not.toContain(
      f.options.resource.privatePath,
    );
    expect(JSON.stringify([plan, result])).not.toContain(
      f.options.resource.key,
    );
    f.session.close();
  });

  it.each([
    "",
    "..",
    ".",
    "a/b.step",
    "a\\b.step",
    "a\0.step",
    " ",
    "x".repeat(256),
  ])("rejects unsafe display filename %j before use", (name) => {
    expect(() =>
      parsePluginFileInput({
        file: { name, resourceUri: "host-resource://owned" },
      }),
    ).toThrow();
  });
  it("refuses unavailable suffixes, paths as URIs and invalid representations", async () => {
    const f = fixture();
    expect(() =>
      pluginFileEntrypointPlan({ name: "viewer", _meta: {} }, f.session.input),
    ).toThrow("ENTRYPOINT_UNAVAILABLE");
    expect(() =>
      parsePluginFileInput({
        file: { name: "bolt.step", resourceUri: "/disposable/bolt.step" },
      }),
    ).toThrow();
    expect(() =>
      f.session.read({
        uri: f.session.input.file.resourceUri,
        _meta: { "openai/resource": { representation: "raw" } },
      }),
    ).toThrow();
    expect(f.adapter.read).not.toHaveBeenCalled();
    f.session.close();
  });

  it("isolates handles for two instances and strips both guest paths before trusted derivation", async () => {
    const a = fixture(),
      b = fixture();
    expect(a.session.input.file.resourceUri).not.toBe(
      b.session.input.file.resourceUri,
    );
    await expect(
      b.session.read({ uri: a.session.input.file.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(b.adapter.read).not.toHaveBeenCalled();
    expect(
      await a.session.toolMetadata({
        "openai/resource": { path: "forged", opaque: [1] },
        "openai/resource.path": "forged",
        progressToken: "same",
      }),
    ).toEqual({
      "openai/resource": { path: a.options.resource.privatePath, opaque: [1] },
      progressToken: "same",
    });
    a.session.close();
    b.session.close();
  });

  it.each(["permission", "instance", "signal", "explicit"] as const)(
    "fences %s revocation with no further reads",
    async (kind) => {
      const f = fixture();
      if (kind === "permission") f.revoke();
      if (kind === "instance") f.closeOwner();
      if (kind === "signal") f.abort.abort();
      if (kind === "explicit") {
        f.session.close();
        f.session.close();
      }
      await expect(
        f.session.read({ uri: f.session.input.file.resourceUri }),
      ).rejects.toThrow();
      expect(f.adapter.read).not.toHaveBeenCalled();
      f.session.close();
    },
  );

  it("fences a revoke during read before delivering bytes", async () => {
    const f = fixture();
    f.adapter.read.mockImplementationOnce(async () => {
      f.revoke();
      return { bytes: new TextEncoder().encode("withheld"), etag: "opaque" };
    });
    await expect(
      f.session.read({ uri: f.session.input.file.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    f.session.close();
  });

  it("captures options and releases a cancelled caller during stalled authorization", async () => {
    const f = fixture();
    let finish!: () => void;
    f.authorize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const requestAbort = new AbortController();
    const pending = f.session.read(
      { uri: f.session.input.file.resourceUri },
      requestAbort.signal,
    );
    await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledTimes(1));
    requestAbort.abort();
    await expect(pending).rejects.toThrow();
    f.options.authorize = vi.fn(async () => {});
    f.options.resource.privatePath = "/forged";
    f.options.resource.key = "forged";
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.adapter.read).not.toHaveBeenCalled();
    const metadata = await f.session.toolMetadata();
    expect(metadata).toEqual({
      "openai/resource": { path: "/disposable/bolt.step" },
    });
    f.session.close();
  });
  function editable(policy = vi.fn(async () => {})) {
    const owned = fixture();
    owned.session.close();
    const managed = managedResourceFixture();
    const session = createPluginFileResourceSession({
      ...owned.options,
      resource: {
        ...owned.options.resource,
        adapter: managed.adapter,
        authorizeWrite: policy,
      },
    });
    return {
      ...owned,
      ...managed,
      session,
      policy,
      uri: session.input.file.resourceUri,
    };
  }
  it("keeps CAS adapters read-only without a composed target write policy", async () => {
    const f = fixture();
    f.session.close();
    const m = managedResourceFixture();
    const session = createPluginFileResourceSession({
      ...f.options,
      resource: { ...f.options.resource, adapter: m.adapter },
    });
    expect(session.capabilities).toEqual({ write: false, subscribe: true });
    expect(
      (await session.read({ uri: session.input.file.resourceUri })).contents[0]
        ._meta["openai/resource"].writable,
    ).toBe(false);
    await expect(
      session.write("write", {
        uri: session.input.file.resourceUri,
        text: "denied",
      }),
    ).rejects.toThrow();
    expect(m.writes()).toBe(0);
    session.close();
  });
  it("preserves conditional conflict, byte limits, binary bytes and duplicate receipts", async () => {
    const f = editable();
    await f.session.read({ uri: f.uri });
    const outcomes = await Promise.all([
      f.session.write("one", {
        uri: f.uri,
        text: "saved",
        ifMatch: "fixture-v1",
      }),
      f.session.write("two", {
        uri: f.uri,
        text: "conflict",
        ifMatch: "fixture-v1",
      }),
    ]);
    expect(outcomes).toEqual([
      { outcome: "saved", etag: "fixture-v2" },
      { outcome: "conflict", etag: "fixture-v2" },
    ]);
    expect(
      await f.session.write("one", {
        uri: f.uri,
        text: "saved",
        ifMatch: "fixture-v1",
      }),
    ).toEqual(outcomes[0]);
    await expect(
      f.session.write("one", { uri: f.uri, text: "changed" }),
    ).rejects.toThrow("PLUGIN_FILE_OPERATION_CHANGED");
    expect(
      await f.session.write("large", { uri: f.uri, text: "😀".repeat(9) }),
    ).toEqual({ outcome: "too-large", maxBytes: 32 });
    expect(f.writes()).toBe(1);
    await f.session.write("binary", { uri: f.uri, blob: "/w==" });
    expect((await f.session.read({ uri: f.uri })).contents[0]).toMatchObject({
      blob: "/w==",
    });
    f.session.close();
  });
  it("reauthorizes cached writes and rejects foreign resources without effects", async () => {
    const f = editable();
    await f.session.read({ uri: f.uri });
    await expect(
      f.session.write("foreign", {
        uri: "host-resource://foreign",
        text: "denied",
      }),
    ).rejects.toThrow();
    expect(f.writes()).toBe(0);
    await f.session.write("save", { uri: f.uri, text: "once" });
    f.revoke();
    await expect(
      f.session.write("save", { uri: f.uri, text: "once" }),
    ).rejects.toThrow();
    expect(f.writes()).toBe(1);
    f.session.close();
  });
  it("does not dispatch a cancelled write after a stalled policy wait", async () => {
    let resume!: () => void;
    const f = editable(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resume = resolve;
          }),
      ),
    );
    await f.session.read({ uri: f.uri });
    const abort = new AbortController();
    const pending = f.session.write(
      "pending",
      { uri: f.uri, text: "denied" },
      abort.signal,
    );
    await vi.waitFor(() => expect(resume).toBeDefined());
    abort.abort();
    await expect(pending).rejects.toThrow();
    resume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.writes()).toBe(0);
    f.session.close();
  });
  it("retains an unknown write receipt rather than retrying its effect", async () => {
    const owned = fixture();
    owned.session.close();
    const m = managedResourceFixture();
    const write = vi.fn(async () => {
      throw new Error("lost acknowledgement");
    });
    const session = createPluginFileResourceSession({
      ...owned.options,
      resource: {
        ...owned.options.resource,
        adapter: { ...m.adapter, conditionalWrite: write },
        authorizeWrite: async () => {},
      },
    });
    const params = { uri: session.input.file.resourceUri, text: "uncertain" };
    await session.read({ uri: params.uri });
    await expect(session.write("unknown", params)).rejects.toMatchObject({
      code: "RESOURCE_OUTCOME_UNKNOWN",
    });
    await expect(session.write("unknown", params)).rejects.toMatchObject({
      code: "RESOURCE_OUTCOME_UNKNOWN",
    });
    expect(write).toHaveBeenCalledTimes(1);
    session.close();
  });
  it("coalesces updates and releases watches after unsubscribe, close or permission revoke", async () => {
    const f = editable();
    const changed = vi.fn();
    await f.session.subscribe({ uri: f.uri }, changed);
    f.changed();
    f.changed();
    f.changed();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    await f.session.unsubscribe({ uri: f.uri });
    expect(f.listeners.size).toBe(0);
    await f.session.subscribe({ uri: f.uri }, changed);
    f.revoke();
    f.changed();
    await vi.waitFor(() => expect(f.listeners.size).toBe(0));
    expect(changed).toHaveBeenCalledTimes(1);
    f.session.close();
    const other = editable();
    await other.session.subscribe({ uri: other.uri }, vi.fn());
    other.session.close();
    expect(other.listeners.size).toBe(0);
  });
  it("cancels a pending subscription and stops the late installed watch", async () => {
    const f = fixture();
    f.session.close();
    let finish!: (stop: () => void) => void;
    const watch = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          finish = resolve;
        }),
    );
    const session = createPluginFileResourceSession({
      ...f.options,
      resource: { ...f.options.resource, adapter: { ...f.adapter, watch } },
    });
    const abort = new AbortController();
    const pending = session.subscribe(
      { uri: session.input.file.resourceUri },
      vi.fn(),
      abort.signal,
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    abort.abort();
    await expect(pending).rejects.toThrow();
    const stop = vi.fn();
    finish(stop);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    session.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("classifies an invalid dispatched write result as unknown and preserves the receipt", async () => {
    const f = fixture();
    f.session.close();
    const m = managedResourceFixture();
    const write = vi.fn(
      async () => ({ outcome: "saved", etag: undefined }) as never,
    );
    const session = createPluginFileResourceSession({
      ...f.options,
      resource: {
        ...f.options.resource,
        adapter: { ...m.adapter, conditionalWrite: write },
        authorizeWrite: async () => {},
      },
    });
    const params = { uri: session.input.file.resourceUri, text: "unknown" };
    await session.read({ uri: params.uri });
    await expect(session.write("bad-result", params)).rejects.toMatchObject({
      code: "RESOURCE_OUTCOME_UNKNOWN",
    });
    await expect(session.write("bad-result", params)).rejects.toMatchObject({
      code: "RESOURCE_OUTCOME_UNKNOWN",
    });
    expect(write).toHaveBeenCalledTimes(1);
    session.close();
  });
});

it("refuses cached write delivery after the original target expiry", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.session.close();
    const managed = managedResourceFixture();
    const session = createPluginFileResourceSession({
      ...f.options,
      resource: {
        ...f.options.resource,
        adapter: managed.adapter,
        authorizeWrite: async () => {},
        expiresAt: Date.now() + 10,
      },
    });
    const params = { uri: session.input.file.resourceUri, text: "saved" };
    await session.read({ uri: params.uri });
    await expect(session.write("once", params)).resolves.toMatchObject({
      outcome: "saved",
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(session.write("once", params)).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    await expect(session.read({ uri: params.uri })).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    session.close();
  } finally {
    vi.useRealTimers();
  }
});

describe("a writable grant kept for a live, renewing owner", () => {
  function writable(
    extra: Partial<Parameters<typeof createPluginFileResourceSession>[0]> = {},
    managed = managedResourceFixture(),
  ) {
    let allowed = true;
    const authorize = vi.fn(async () => {
      if (!allowed) throw new Error("root no longer allowed");
    });
    const lifetime = new AbortController();
    const session = createPluginFileResourceSession({
      owner: {
        actorId: "actor",
        projectId: "project",
        subject: "verified-subject",
        workspaceId: "workspace",
        instanceId: "viewer",
        generation: 1,
        serverId: "server",
        bindingId: "target",
      },
      resource: {
        key: "private-key",
        name: "bolt.step",
        privatePath: "/disposable/bolt.step",
        maxBytes: 64,
        adapter: managed.adapter,
        authorizeWrite: async () => {},
      },
      signal: lifetime.signal,
      authorize,
      assertLive: () => {},
      ...extra,
    });
    return {
      session,
      managed,
      authorize,
      lifetime,
      uri: session.input.file.resourceUri,
      refuse: () => {
        allowed = false;
      },
    };
  }
  const clock = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("renews past 30 minutes and saves with its ETag semantics intact", async () => {
    clock();
    try {
      const f = writable();
      const read = await f.session.read({ uri: f.uri });
      const meta = read.contents[0]._meta["openai/resource"];
      expect(meta).toEqual({ etag: "fixture-v1", writable: true });
      // The owner renews every 10 minutes; 45 minutes later it's the SAME grant.
      for (let round = 0; round < 4; round++) {
        vi.advanceTimersByTime(10 * 60_000);
        await expect(f.session.renew()).resolves.toBe(Date.now() + 30 * 60_000);
      }
      vi.advanceTimersByTime(5 * 60_000);
      expect(f.session.live).toBe(true);
      expect(f.session.input.file.resourceUri).toBe(f.uri);
      // Each renewal re-checked the actor and the target.
      expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(5);
      // The save the App prepared against its first read lands.
      await expect(
        f.session.write("save", { uri: f.uri, text: "edited", ifMatch: meta.etag }),
      ).resolves.toEqual({ outcome: "saved", etag: "fixture-v2" });
      // A stale ETag still conflicts, and a retried save is not repeated.
      await expect(
        f.session.write("stale", { uri: f.uri, text: "stale", ifMatch: meta.etag }),
      ).resolves.toEqual({ outcome: "conflict", etag: "fixture-v2" });
      await expect(
        f.session.write("save", { uri: f.uri, text: "edited", ifMatch: meta.etag }),
      ).resolves.toEqual({ outcome: "saved", etag: "fixture-v2" });
      expect(f.managed.writes()).toBe(1);
      f.lifetime.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a refused renewal lapse at its deadline and never revives it", async () => {
    clock();
    try {
      const f = writable();
      await f.session.read({ uri: f.uri });
      vi.advanceTimersByTime(10 * 60_000);
      f.refuse();
      await expect(f.session.renew()).rejects.toThrow("root no longer allowed");
      // Not revoked by the refusal: it ends at its own deadline.
      expect(f.session.live).toBe(true);
      vi.advanceTimersByTime(20 * 60_000);
      expect(f.session.live).toBe(false);
      await expect(f.session.renew()).rejects.toThrow("RESOURCE_DENIED");
      await expect(
        f.session.write("late", { uri: f.uri, text: "late" }),
      ).rejects.toThrow("RESOURCE_DENIED");
      expect(f.managed.writes()).toBe(0);
      f.lifetime.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues a lost grant again under its URI, refusing a save until the App reads again", async () => {
    const managed = managedResourceFixture();
    const id = { resourceId: "c".repeat(64), stableIdentity: true };
    const first = writable(id, managed);
    await first.session.read({ uri: first.uri });
    // A restart loses the in-memory grant and its write receipts.
    first.session.close();
    const again = writable({ ...id, reissued: true }, managed);
    expect(again.uri).toBe(first.uri);
    await expect(
      again.session.write("save", { uri: again.uri, text: "edited", ifMatch: "fixture-v1" }),
    ).rejects.toThrow("RESOURCE_READ_REQUIRED");
    expect(managed.writes()).toBe(0);
    const read = await again.session.read({ uri: again.uri });
    await expect(
      again.session.write("save-2", {
        uri: again.uri,
        text: "edited",
        ifMatch: read.contents[0]._meta["openai/resource"].etag,
      }),
    ).resolves.toEqual({ outcome: "saved", etag: "fixture-v2" });
    again.lifetime.abort();
    first.lifetime.abort();
  });
});

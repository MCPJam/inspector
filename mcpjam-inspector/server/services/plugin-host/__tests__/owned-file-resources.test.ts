import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OwnedFileResources } from "../owned-file-resources.js";
import type { PluginPreviewInstance } from "../instances.js";
const instance = {
  owner: {
    actorId: "a",
    projectId: "p",
    workspaceId: "w",
    instanceId: "i",
    generation: 1,
    serverId: "s",
    bindingId: "b",
    placement: "interactive",
  },
  subject: "credential",
  activation: {
    file: {
      kind: "saved-resource",
      version: 1,
      uri: "resource://a",
      name: "a.cad",
    },
  },
} as PluginPreviewInstance;
function writableInstance(root: string) {
  return {
    ...instance,
    activation: {
      ...instance.activation,
      file: {
        ...instance.activation.file!,
        localTarget: {
          root,
          relativePath: "a.cad",
          uri: "resource://a",
          exclusiveWrites: true as const,
        },
      },
    },
  } as PluginPreviewInstance;
}
describe("owned saved resource ports", () => {
  it("replaces an expired read-only grant for a renewed owner under the same URI", () => {
    vi.useFakeTimers();
    const lifetime = new AbortController();
    try {
      const resources = new OwnedFileResources();
      const first = resources.get(instance, lifetime.signal);
      expect(resources.get(instance, lifetime.signal)).toBe(first);
      vi.advanceTimersByTime(30 * 60_000 + 1);
      const second = resources.get(instance, lifetime.signal);
      expect(second).not.toBe(first);
      expect(second.input.file.resourceUri).toBe(first.input.file.resourceUri);
      expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    } finally {
      lifetime.abort();
      vi.useRealTimers();
    }
  });
  it("keeps one URI per writable viewer; a lost grant is issued again in place without its volatile state", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "owned-file-live-")),
    );
    const lifetime = new AbortController();
    try {
      await writeFile(path.join(root, "a.cad"), "disposable");
      const local = writableInstance(root);
      const ports = { read: vi.fn(), authorize: vi.fn(async () => {}) };
      const resources = new OwnedFileResources(() => "local");
      const session = resources.get(local, lifetime.signal, { opened: true });
      expect(session.capabilities).toEqual({ write: true, subscribe: true });
      expect(resources.get(local, lifetime.signal)).toBe(session);
      const read = await resources.run(local, ports, () =>
        session.read({ uri: session.input.file.resourceUri }),
      );
      const etag = read.contents[0]._meta["openai/resource"].etag;
      // A restart loses the grant: a new one bound to the same instance takes
      // its place under the SAME URI, with no write receipts or read state.
      const restarted = new OwnedFileResources(() => "local");
      const again = restarted.get(local, lifetime.signal);
      expect(again.input.file.resourceUri).toBe(session.input.file.resourceUri);
      await expect(
        restarted.run(local, ports, () =>
          again.write(crypto.randomUUID(), {
            uri: again.input.file.resourceUri,
            text: "edited",
            ifMatch: etag,
          }),
        ),
      ).rejects.toThrow("RESOURCE_READ_REQUIRED");
      // Reading again gives the App the current version to save against.
      const current = await restarted.run(local, ports, () =>
        again.read({ uri: again.input.file.resourceUri }),
      );
      await expect(
        restarted.run(local, ports, () =>
          again.write(crypto.randomUUID(), {
            uri: again.input.file.resourceUri,
            text: "edited",
            ifMatch: current.contents[0]._meta["openai/resource"].etag,
          }),
        ),
      ).resolves.toMatchObject({ outcome: "saved" });
    } finally {
      lifetime.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("renews a writable viewer's grant past 30 minutes in place", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "owned-file-renew-")),
    );
    const lifetime = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await writeFile(path.join(root, "a.cad"), "disposable");
      const local = writableInstance(root);
      const authorize = vi.fn(async () => {});
      const ports = { read: vi.fn(), authorize };
      const resources = new OwnedFileResources(() => "local");
      const session = resources.get(local, lifetime.signal, { opened: true });
      const uri = session.input.file.resourceUri;
      const read = await resources.run(local, ports, () => session.read({ uri }));
      // Outside a request's ports there is no authority to renew with.
      await expect(
        Promise.resolve().then(() =>
          resources.renew(local, lifetime.signal, lifetime.signal),
        ),
      ).rejects.toThrow("RESOURCE_DENIED");
      for (let round = 0; round < 4; round++) {
        vi.advanceTimersByTime(10 * 60_000);
        await resources.run(local, ports, () =>
          resources.renew(local, lifetime.signal, lifetime.signal),
        );
      }
      // The same live grant: same URI and writable read state.
      expect(resources.get(local, lifetime.signal)).toBe(session);
      vi.useRealTimers();
      await expect(
        resources.run(local, ports, () =>
          session.write(crypto.randomUUID(), {
            uri,
            text: "edited",
            ifMatch: read.contents[0]._meta["openai/resource"].etag,
          }),
        ),
      ).resolves.toMatchObject({ outcome: "saved" });
    } finally {
      vi.useRealTimers();
      lifetime.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("restores the same public resource identity but never the previous request authority", async () => {
    const lifetime = new AbortController();
    const first = new OwnedFileResources().get(instance, lifetime.signal);
    const restored = new OwnedFileResources().get(instance, lifetime.signal);
    expect(restored.input.file.resourceUri).toBe(first.input.file.resourceUri);
    await expect(
      restored.read({ uri: first.input.file.resourceUri }),
    ).rejects.toThrow();
    lifetime.abort();
  });
  it("retains identity, but requires fresh request ports for each read", async () => {
    const resources = new OwnedFileResources();
    const lifetime = new AbortController();
    const session = resources.get(instance, lifetime.signal);
    const read = vi.fn(async () => ({
      bytes: new TextEncoder().encode("disposable"),
      etag: "v1",
    }));
    const authorize = vi.fn(async () => {});
    const params = { uri: session.input.file.resourceUri };
    const result = await resources.run(instance, { read, authorize }, () =>
      session.read(params),
    );
    expect(JSON.stringify(result)).toContain("disposable");
    expect(read).toHaveBeenCalledOnce();
    expect(authorize.mock.calls.length).toBeGreaterThan(1);
    await expect(session.read(params)).rejects.toThrow();
    lifetime.abort();
  });
  it("refuses credential substitution and closes with its original owner", async () => {
    const resources = new OwnedFileResources();
    const lifetime = new AbortController();
    const session = resources.get(instance, lifetime.signal);
    expect(() =>
      resources.get({ ...instance, subject: "other" }, lifetime.signal),
    ).toThrow();
    lifetime.abort();
    await expect(
      resources.run(instance, { read: vi.fn(), authorize: vi.fn() }, () =>
        session.read({ uri: session.input.file.resourceUri }),
      ),
    ).rejects.toThrow();
  });
});

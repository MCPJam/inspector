import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadOnlyResourceAdapter } from "../read-only-resource-adapter.js";
import {
  ResourceGrantService,
  type ResourceOwner,
} from "../resource-grants.js";

type ReadPort = Parameters<typeof createReadOnlyResourceAdapter>[0]["session"];
const key = "private-bound-key";
const privatePath = "/disposable-execution/file.txt";
const signal = () => new AbortController().signal;
const encoder = new TextEncoder();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function bytesStream(chunks: Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
}

function bind(session: ReadPort, maxBytes = 32, mimeType?: string) {
  return createReadOnlyResourceAdapter({
    session,
    key,
    privatePath,
    maxBytes,
    mimeType,
  });
}

describe("bound read-only execution adapter", () => {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid byte budget %s without opening a file",
    (maxBytes) => {
      const session = { readFile: vi.fn() };
      expect(() => bind(session, maxBytes)).toThrow(
        "Invalid resource byte limit",
      );
      expect(session.readFile).not.toHaveBeenCalled();
    },
  );

  it("requires a trusted key and path at construction", () => {
    const session = { readFile: vi.fn() };
    for (const invalid of [{ key: "" }, { privatePath: "" }]) {
      expect(() =>
        createReadOnlyResourceAdapter({
          session,
          key,
          privatePath,
          maxBytes: 32,
          ...invalid,
        }),
      ).toThrow("Invalid resource binding");
    }
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it("opens only its bound path through the session and returns exact bytes", async () => {
    const session = {
      readFile: vi.fn(async () =>
        bytesStream([encoder.encode("café"), Uint8Array.of(0, 255)]),
      ),
    };
    const activeSignal = signal();
    const adapter = bind(session, 7, "application/octet-stream");
    const version = await adapter.read(key, activeSignal);
    expect(session.readFile).toHaveBeenCalledExactlyOnceWith({
      path: privatePath,
      abortSignal: activeSignal,
    });
    expect(version.bytes).toEqual(
      Uint8Array.from([...encoder.encode("café"), 0, 255]),
    );
    expect(version.etag).toBe(
      `sha256:${createHash("sha256").update(version.bytes).digest("hex")}`,
    );
    expect(version.mimeType).toBe("application/octet-stream");
    expect(Object.keys(adapter)).toEqual(["read"]);
    expect(JSON.stringify(version)).not.toContain(privatePath);
    expect(adapter.conditionalWrite).toBeUndefined();
    expect(adapter.watch).toBeUndefined();
  });

  it("keeps the bound path and budget stable if the host options object changes", async () => {
    const session = {
      readFile: vi.fn(async () => bytesStream([Uint8Array.of(1)])),
    };
    const options = { session, key, privatePath, maxBytes: 1 };
    const adapter = createReadOnlyResourceAdapter(options);
    options.privatePath = "/other/file";
    options.key = "other-key";
    options.maxBytes = 0;
    await expect(adapter.read(key, signal())).resolves.toMatchObject({
      bytes: Uint8Array.of(1),
    });
    expect(session.readFile).toHaveBeenCalledWith({
      path: privatePath,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("refuses a foreign key before session I/O", async () => {
    const session = { readFile: vi.fn() };
    await expect(
      bind(session).read("app-supplied-path", signal()),
    ).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it("refuses an already aborted operation before session I/O", async () => {
    const session = { readFile: vi.fn() };
    const controller = new AbortController();
    const reason = new Error("closed");
    controller.abort(reason);
    await expect(bind(session).read(key, controller.signal)).rejects.toBe(
      reason,
    );
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it("handles empty files with a zero byte budget", async () => {
    const result = await bind(
      { readFile: async () => bytesStream([]) },
      0,
    ).read(key, signal());
    expect(result.bytes).toHaveLength(0);
    expect(result.etag).toBe(`sha256:${createHash("sha256").digest("hex")}`);
    expect(result).not.toHaveProperty("mimeType");
  });

  it("refuses missing files with a path-free error", async () => {
    await expect(
      bind({ readFile: async () => null }).read(key, signal()),
    ).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
      message: "RESOURCE_DENIED",
    });
  });

  it("masks provider errors that contain private details", async () => {
    await expect(
      bind({
        readFile: async () => {
          throw new Error(`secret: ${privatePath}`);
        },
      }).read(key, signal()),
    ).rejects.toMatchObject({
      code: "RESOURCE_INVALID",
      message: "RESOURCE_INVALID",
    });
  });

  it("accepts an exact budget across chunks and refuses overflow promptly", async () => {
    const cancelled = vi.fn();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(
            index++ === 0 ? Uint8Array.of(1, 2) : Uint8Array.of(3, 4),
          );
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    await expect(
      bind({ readFile: async () => stream }, 3).read(key, signal()),
    ).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
    });
    expect(index).toBe(2);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    await expect(
      bind(
        {
          readFile: async () =>
            bytesStream([Uint8Array.of(1), Uint8Array.of(2)]),
        },
        2,
      ).read(key, signal()),
    ).resolves.toMatchObject({
      bytes: Uint8Array.of(1, 2),
    });
  });

  it("owns accepted Buffer chunks when the producer reuses its buffer", async () => {
    const buffer = Buffer.from([1, 2]);
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index++ === 0) controller.enqueue(buffer);
          else if (index === 2) {
            buffer.set([3, 4]);
            controller.enqueue(buffer);
          } else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      bind({ readFile: async () => stream }, 4).read(key, signal()),
    ).resolves.toMatchObject({
      bytes: Uint8Array.of(1, 2, 3, 4),
    });
  });

  it("refuses malformed chunks and cancels the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue("not-bytes" as unknown as Uint8Array);
      },
      cancel,
    });
    await expect(
      bind({ readFile: async () => stream }).read(key, signal()),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("masks stream failures and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`failed ${privatePath}`));
      },
    });
    await expect(
      bind({ readFile: async () => stream }).read(key, signal()),
    ).rejects.toMatchObject({
      code: "RESOURCE_INVALID",
      message: "RESOURCE_INVALID",
    });
    expect(stream.locked).toBe(false);
  });

  it("cancels a stalled reader without waiting for provider cleanup", async () => {
    const reading = deferred<void>();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
          return new Promise<void>(() => {});
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const result = bind({ readFile: async () => stream }).read(
      key,
      controller.signal,
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await reading.promise;
    controller.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("cancels a stream that opens after the caller has been aborted", async () => {
    const opening = deferred<ReadableStream<Uint8Array> | null>();
    const cancelled = deferred<void>();
    const cancel = vi.fn(() => cancelled.resolve());
    const controller = new AbortController();
    const result = bind({ readFile: () => opening.promise }).read(
      key,
      controller.signal,
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    const stream = new ReadableStream<Uint8Array>({ cancel });
    opening.resolve(stream);
    await cancelled.promise;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("observes a late open rejection after cancellation", async () => {
    const opening = deferred<ReadableStream<Uint8Array> | null>();
    const controller = new AbortController();
    const result = bind({ readFile: () => opening.promise }).read(
      key,
      controller.signal,
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    opening.reject(new Error(`late ${privatePath}`));
    await Promise.resolve();
  });

  it("cleans up when the provider aborts synchronously while opening", async () => {
    const controller = new AbortController();
    const reason = new Error("binding revoked during open");
    const cancelled = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.resolve();
        return Promise.reject(new Error("cleanup failure"));
      },
    });
    const adapter = bind({
      readFile: () => {
        controller.abort(reason);
        return Promise.resolve(stream);
      },
    });
    await expect(adapter.read(key, controller.signal)).rejects.toBe(reason);
    await cancelled.promise;
    expect(stream.locked).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("releases abort listeners after successful reads and provider errors", async () => {
    const activeSignal = signal();
    const adapter = bind({
      readFile: async () => bytesStream([Uint8Array.of(1)]),
    });
    for (let index = 0; index < 3; index++) {
      await adapter.read(key, activeSignal);
      expect(getEventListeners(activeSignal, "abort")).toHaveLength(0);
    }
    await expect(
      bind({
        readFile: async () => {
          throw new Error("provider unavailable");
        },
      }).read(key, activeSignal),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    expect(getEventListeners(activeSignal, "abort")).toHaveLength(0);
  });
});

describe("disposable filesystem plus the existing resource grant service", () => {
  const directories: string[] = [];
  const owner: ResourceOwner = {
    actorId: "actor",
    projectId: "project",
    subject: "verified-subject",
    workspaceId: "disposable-workspace",
    instanceId: "file-app",
    generation: 1,
    serverId: "fixture-server",
    bindingId: "disposable-binding",
  };
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
  async function fixture(
    bytes: Uint8Array,
    mimeType = "application/octet-stream",
    maxBytes = 32,
  ) {
    const directory = await mkdtemp(
      join(tmpdir(), "plugin-read-only-fixture-"),
    );
    directories.push(directory);
    const path = join(directory, "fixture.bin");
    await writeFile(path, bytes);
    const read = vi.fn<ReadPort["readFile"]>(
      async ({ path: requested, abortSignal }) => {
        if (requested !== path) throw new Error("Fixture scope denied");
        const file = await open(requested, "r");
        return Readable.toWeb(
          file.createReadStream({ highWaterMark: 3, signal: abortSignal }),
        ) as ReadableStream<Uint8Array>;
      },
    );
    const adapter = createReadOnlyResourceAdapter({
      session: { readFile: read },
      key,
      privatePath: path,
      mimeType,
      maxBytes,
    });
    const authorize = vi.fn(async () => {});
    const service = new ResourceGrantService({
      authorize,
      maxBytes,
      mintId: () => "disposable-handle",
    });
    const { resourceUri } = service.open(owner, {
      key,
      adapter,
      privatePath: path,
    });
    return { path, read, adapter, authorize, service, resourceUri };
  }

  it("returns real UTF-8 file bytes as text and advertises read-only", async () => {
    const data = encoder.encode("hello café\n");
    const f = await fixture(data, "text/plain");
    const result = await f.service.read(owner, {
      uri: f.resourceUri,
      representation: "text",
    });
    expect(result).toEqual({
      contents: [
        {
          uri: f.resourceUri,
          mimeType: "text/plain",
          text: "hello café\n",
          _meta: {
            "openai/resource": {
              etag: `sha256:${createHash("sha256").update(data).digest("hex")}`,
              writable: false,
            },
          },
        },
      ],
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(f.path);
  });

  it("returns real binary file bytes as base64 and refuses invalid text", async () => {
    const data = Uint8Array.of(0, 255, 192, 175, 1);
    const f = await fixture(data);
    const result = await f.service.read(owner, { uri: f.resourceUri });
    expect(result.contents[0]).toMatchObject({
      blob: Buffer.from(data).toString("base64"),
    });
    await expect(
      f.service.read(owner, { uri: f.resourceUri, representation: "text" }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_TEXT" });
    const explicit = await f.service.read(owner, {
      uri: f.resourceUri,
      representation: "blob",
    });
    expect(explicit.contents[0]).toMatchObject({
      blob: Buffer.from(data).toString("base64"),
    });
  });

  it("changes the opaque snapshot etag when fixture bytes change", async () => {
    const f = await fixture(Uint8Array.of(1));
    const before = await f.adapter.read(key, signal());
    await writeFile(f.path, Uint8Array.of(2));
    const after = await f.adapter.read(key, signal());
    expect(after.etag).not.toBe(before.etag);
    expect(before.bytes).toEqual(Uint8Array.of(1));
    expect(after.bytes).toEqual(Uint8Array.of(2));
  });

  it("refuses writes, watches, foreign owners and revoked handles without extra I/O", async () => {
    const data = Uint8Array.of(1, 2);
    const f = await fixture(data);
    await f.service.read(owner, { uri: f.resourceUri });
    await expect(
      f.service.write(owner, { uri: f.resourceUri, text: "changed" }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    await expect(
      f.service.subscribe(owner, f.resourceUri, vi.fn()),
    ).rejects.toMatchObject({ code: "RESOURCE_UNSUPPORTED" });
    await expect(
      f.service.read({ ...owner, generation: 2 }, { uri: f.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    f.service.closeBinding(owner.bindingId);
    await expect(
      f.service.read(owner, { uri: f.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(f.read).toHaveBeenCalledOnce();
    expect(await readFile(f.path)).toEqual(Buffer.from(data));
  });

  it("enforces the stream budget on a real file before returning contents", async () => {
    const f = await fixture(
      Uint8Array.of(1, 2, 3, 4),
      "application/octet-stream",
      3,
    );
    await expect(
      f.service.read(owner, { uri: f.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(f.read).toHaveBeenCalledOnce();
  });

  it("denies permission revocation before reads and after their completion", async () => {
    const f = await fixture(Uint8Array.of(1));
    f.authorize.mockRejectedValueOnce(new Error("policy changed"));
    await expect(
      f.service.read(owner, { uri: f.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(f.read).not.toHaveBeenCalled();
    const after = await fixture(Uint8Array.of(2));
    after.authorize
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("policy changed"));
    await expect(
      after.service.read(owner, { uri: after.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(after.read).toHaveBeenCalledOnce();
    await expect(
      after.service.read(owner, { uri: after.resourceUri }),
    ).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(after.read).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight adapter read when its execution binding closes", async () => {
    const reading = deferred<void>();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const service = new ResourceGrantService({
      authorize: async () => {},
      maxBytes: 32,
    });
    const adapter = bind({ readFile: async () => stream });
    const { resourceUri } = service.open(owner, { adapter, key });
    const pending = service.read(owner, { uri: resourceUri });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await reading.promise;
    service.closeBinding(owner.bindingId);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});

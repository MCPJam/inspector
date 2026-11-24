import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalFileTargetAdapter } from "../local-file-target.js";
import { createPluginFileResourceSession } from "../file-resource-session.js";
import { fileReadResponse, readFileWriteBody } from "../file-transfer.js";
import {
  encodePluginFileMetadata,
  PLUGIN_FILE_MAX_BYTES,
  PLUGIN_FILE_MEDIA_TYPE,
  readPluginFileBody,
  decodePluginFileMetadata,
} from "../../../../shared/plugin-file-transfer.js";
import { PLUGIN_FILE_METADATA_HEADER } from "../../../../shared/plugin-file-headers.js";
import { webBodyLimit } from "../../../middleware/web-body-limit.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "mcpjam-file-transfer-")),
  );
  roots.push(root);
  const filename = path.join(root, "assembly.stl");
  const bytes = new Uint8Array(6_957_943).fill(97);
  await writeFile(filename, bytes);
  const adapter = createLocalFileTargetAdapter({
    root,
    relativePath: "assembly.stl",
    uri: "cad://assembly",
    exclusiveWrites: true,
  });
  const read = vi.spyOn(adapter, "read");
  const lifetime = new AbortController();
  const session = createPluginFileResourceSession({
    owner: {
      actorId: "a",
      projectId: "p",
      subject: "s",
      workspaceId: "w",
      instanceId: "i",
      generation: 1,
      serverId: "server",
      bindingId: "binding",
    },
    resource: {
      key: "cad://assembly",
      name: "assembly.stl",
      adapter,
      maxBytes: PLUGIN_FILE_MAX_BYTES,
      authorizeWrite: async () => {},
    },
    signal: lifetime.signal,
    assertLive() {},
    authorize: async () => {},
  });
  const app = new Hono();
  app.use("/api/web/*", webBodyLimit());
  app.use("*", bodyLimit({ maxSize: PLUGIN_FILE_MAX_BYTES }));
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer fixture")
      return c.json({ denied: true }, 403);
    await next();
  });
  app.post("/api/web/apps/plugin-instances/files/read", async (c) =>
    fileReadResponse(
      c,
      await session.read({
        uri: session.input.file.resourceUri,
        _meta: { "openai/resource": { representation: "blob" } },
      }),
      [],
    ),
  );
  app.post("/api/web/apps/plugin-instances/files/write", async (c) => {
    const body = (await readFileWriteBody(c)) as {
      operationId: string;
      params: unknown;
    };
    return c.json(await session.write(body.operationId, body.params));
  });
  return { app, bytes, filename, read, session, lifetime };
}

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const base = "/api/web/apps/plugin-instances/files/";
describe("bounded owned file binary transport", () => {
  it("reads and saves the full assembly through HTTP with byte identity and ETag protection", async () => {
    const f = await fixture();
    try {
      const response = await f.app.request(base + "read", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          accept: PLUGIN_FILE_MEDIA_TYPE,
        },
      });
      expect(response.status).toBe(200);
      const metadata = decodePluginFileMetadata(
        response.headers.get(PLUGIN_FILE_METADATA_HEADER),
      );
      expect(metadata.representation).toBe("blob");
      expect(
        digest(
          await readPluginFileBody(response, new AbortController().signal),
        ),
      ).toBe(digest(f.bytes));
      const content = metadata.content as {
        _meta: { "openai/resource": { etag: string } };
      };
      const next = new Uint8Array(f.bytes.length).fill(98);
      const save = (ifMatch: string) =>
        f.app.request(base + "write", {
          method: "POST",
          headers: {
            authorization: "Bearer fixture",
            "content-type": PLUGIN_FILE_MEDIA_TYPE,
            [PLUGIN_FILE_METADATA_HEADER]: encodePluginFileMetadata({
              operationId: crypto.randomUUID(),
              params: { uri: f.session.input.file.resourceUri, ifMatch },
            }),
          },
          body: next,
        });
      expect(
        await (await save(content._meta["openai/resource"].etag)).json(),
      ).toMatchObject({ outcome: "saved" });
      expect(digest(await readFile(f.filename))).toBe(digest(next));
      expect(
        await (await save(content._meta["openai/resource"].etag)).json(),
      ).toMatchObject({ outcome: "conflict" });
    } finally {
      f.lifetime.abort();
    }
  });

  it("denies unauthorized reads and oversized writes before the adapter", async () => {
    const f = await fixture();
    try {
      expect(
        (await f.app.request(base + "read", { method: "POST" })).status,
      ).toBe(403);
      expect(f.read).not.toHaveBeenCalled();
      const response = await f.app.request(base + "write", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture",
          "content-type": PLUGIN_FILE_MEDIA_TYPE,
        },
        body: new Uint8Array(PLUGIN_FILE_MAX_BYTES + 1),
      });
      expect(response.status).toBe(413);
      expect(digest(await readFile(f.filename))).toBe(digest(f.bytes));
    } finally {
      f.lifetime.abort();
    }
  });

  it("rejects truncated or enlarged bodies despite a misleading Content-Length", async () => {
    await expect(
      readPluginFileBody(
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-length": "999" },
        }),
        new AbortController().signal,
        3,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    await expect(
      readPluginFileBody(
        new Response(new Uint8Array(PLUGIN_FILE_MAX_BYTES + 1), {
          headers: { "content-length": "1" },
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
  });

  it("cancels the body when declared raw size is invalid", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(readPluginFileBody(response, new AbortController().signal, PLUGIN_FILE_MAX_BYTES + 1))
      .rejects.toMatchObject({ code: "RESOURCE_INVALID" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("preserves the size failure if cancelling the stream also fails", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PLUGIN_FILE_MAX_BYTES + 1));
        },
        cancel() {
          throw new Error("cancel failed");
        },
      }),
    );
    await expect(
      readPluginFileBody(response, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
      errors: [
        expect.any(Error),
        expect.objectContaining({ message: "cancel failed" }),
      ],
    });
    expect(response.body?.locked).toBe(false);
  });

  it("bounds cancellation that never completes and releases the reader", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PLUGIN_FILE_MAX_BYTES + 1));
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
    );
    await expect(
      readPluginFileBody(response, new AbortController().signal),
    ).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a pending binary read and bounds a response without Content-Length", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    const controller = new AbortController();
    const pending = readPluginFileBody(response, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(
      readPluginFileBody(
        new Response(new Uint8Array(PLUGIN_FILE_MAX_BYTES + 1)),
        new AbortController().signal,
      ),
    ).rejects.toThrow("RESOURCE_TOO_LARGE");
  });
});

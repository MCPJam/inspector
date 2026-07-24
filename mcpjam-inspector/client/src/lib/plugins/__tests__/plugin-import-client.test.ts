import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  commitImport,
  PLUGIN_COMMIT_NOT_AVAILABLE,
  startPluginImportFromFolder,
  startPluginImportFromZip,
  uploadBundleToStorage,
  type PluginConvexClient,
} from "../plugin-import-client.js";

function makeConvex(overrides?: {
  uploadUrl?: string;
  importId?: string;
  inspectStatus?: "preview_ready" | "failed";
}) {
  const uploadUrl = overrides?.uploadUrl ?? "https://storage.example/upload";
  const importId = overrides?.importId ?? "import_1";
  const mutation = vi.fn(async (name: string) => {
    if (String(name).includes("generateBundleUploadUrl")) return uploadUrl;
    if (String(name).includes("createImport")) return { importId };
    throw new Error(`unexpected mutation ${name}`);
  });
  const action = vi.fn(async () => ({
    importId,
    status: overrides?.inspectStatus ?? "preview_ready",
  }));
  const query = vi.fn(async () => null);
  const convex = { mutation, query, action } as unknown as PluginConvexClient;
  return { convex, mutation, action, query, uploadUrl, importId };
}

describe("uploadBundleToStorage", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("POSTs the blob and returns the storageId", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: "st_123" }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const id = await uploadBundleToStorage(
      "https://storage.example/upload",
      new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }),
    );
    expect(id).toBe("st_123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws on a non-ok upload response", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Server Error",
    })) as unknown as typeof fetch;
    await expect(
      uploadBundleToStorage("https://x", new Blob([])),
    ).rejects.toThrow(/Failed to upload plugin bundle/);
  });

  it("throws when the response omits a storageId", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      uploadBundleToStorage("https://x", new Blob([])),
    ).rejects.toThrow(/storageId/);
  });
});

describe("startPluginImportFromZip", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: "st_from_zip" }),
    })) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs upload → createImport → inspect and returns the result", async () => {
    const { convex, mutation, action } = makeConvex();
    const result = await startPluginImportFromZip(convex, {
      projectId: "proj_1",
      bundle: new Blob([new Uint8Array([1])], { type: "application/zip" }),
      sourceLabel: "demo.zip",
    });

    expect(result.importId).toBe("import_1");
    expect(result.bundleStorageId).toBe("st_from_zip");
    expect(result.inspect.status).toBe("preview_ready");

    // createImport received the uploaded storage id + sanitizable label.
    const createCall = mutation.mock.calls.find((c) =>
      String(c[0]).includes("createImport"),
    );
    expect(createCall?.[1]).toMatchObject({
      projectId: "proj_1",
      bundleStorageId: "st_from_zip",
      sourceLabel: "demo.zip",
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it("surfaces a failed inspect status", async () => {
    const { convex } = makeConvex({ inspectStatus: "failed" });
    const result = await startPluginImportFromZip(convex, {
      projectId: "proj_1",
      bundle: new Blob([]),
    });
    expect(result.inspect.status).toBe("failed");
  });
});

describe("startPluginImportFromFolder", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: "st_folder" }),
    })) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("zips the folder then runs the same flow", async () => {
    const { convex } = makeConvex({ importId: "import_folder" });
    const files = new Map([
      [".codex-plugin/plugin.json", new TextEncoder().encode("{}")],
    ]);
    const result = await startPluginImportFromFolder(convex, {
      projectId: "proj_1",
      files,
    });
    expect(result.importId).toBe("import_folder");
    expect(result.bundleStorageId).toBe("st_folder");
  });
});

describe("commitImport stub (backend BE-4 not merged)", () => {
  it("throws a stable not-available error", async () => {
    const { convex } = makeConvex();
    await expect(
      commitImport(convex, { importId: "import_1" }),
    ).rejects.toThrow(PLUGIN_COMMIT_NOT_AVAILABLE);
  });
});

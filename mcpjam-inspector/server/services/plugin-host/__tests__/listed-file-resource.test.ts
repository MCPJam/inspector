import { describe, expect, it, vi } from "vitest";
import {
  readListedFileBytes,
  resolveListedFileResource,
} from "../listed-file-resource.js";

const signal = new AbortController().signal;
describe("listed file resource admission", () => {
  it("uses the actual current listing, including pagination", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({ resources: [], nextCursor: "next" })
      .mockResolvedValueOnce({
        resources: [{ uri: "resource://a", name: "a.cad" }],
      });
    await expect(
      resolveListedFileResource(
        { listResources } as never,
        "saved",
        "resource://a",
        signal,
      ),
    ).resolves.toEqual({ uri: "resource://a", name: "a.cad" });
    expect(listResources).toHaveBeenNthCalledWith(
      2,
      "saved",
      { cursor: "next" },
      { signal, cacheMode: "bypass" },
    );
  });
  it.each(["../a.cad", "folder/a.cad", "a\\b.cad", "a\0.cad", ".", ""])(
    "refuses unsafe display filename %j",
    async (name) => {
      const listResources = vi
        .fn()
        .mockResolvedValue({ resources: [{ uri: "resource://a", name }] });
      await expect(
        resolveListedFileResource(
          { listResources } as never,
          "saved",
          "resource://a",
          signal,
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses a URI absent from the current saved server", async () => {
    const listResources = vi.fn().mockResolvedValue({ resources: [] });
    await expect(
      resolveListedFileResource(
        { listResources } as never,
        "saved",
        "file:///private",
        signal,
      ),
    ).rejects.toThrow();
  });
  it("bounds cyclic pagination", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValue({ resources: [], nextCursor: "same" });
    await expect(
      resolveListedFileResource(
        { listResources } as never,
        "saved",
        "resource://a",
        signal,
      ),
    ).rejects.toThrow();
    expect(listResources).toHaveBeenCalledTimes(2);
  });
  it("retains exact Unicode bytes and digest", () => {
    const value = readListedFileBytes(
      { contents: [{ uri: "resource://a", text: "hello 🧩\0" }] },
      "resource://a",
    );
    expect(new TextDecoder().decode(value.bytes)).toBe("hello 🧩\0");
    expect(value.etag).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects oversized, missing and duplicate content", () => {
    for (const contents of [
      [],
      [{ uri: "resource://other", text: "a" }],
      [
        { uri: "resource://a", text: "a" },
        { uri: "resource://a", text: "b" },
      ],
      [{ uri: "resource://a", text: "a".repeat(1024 * 1024 + 1) }],
    ]) {
      expect(() => readListedFileBytes({ contents }, "resource://a")).toThrow();
    }
  });
});

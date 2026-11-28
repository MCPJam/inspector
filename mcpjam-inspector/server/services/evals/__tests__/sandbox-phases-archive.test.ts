import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header, type HeaderData } from "tar";
import {
  buildGradingArchive,
  fetchGradingArchive,
  MAX_GRADING_ARCHIVE_BYTES,
  readGradingArchive,
} from "../sandbox-phases/grading-archive.js";
import type { GradingFileEntry } from "../sandbox-phases/grading-files.js";

// EFTW-90: a graded iteration keeps what its grading box was given, so a
// draft evaluator can later be tested on exactly that.

const bytes = (text: string) => new TextEncoder().encode(text);
const iterationJson = JSON.stringify({
  version: 1,
  scenario: { title: "Case" },
});
const declared = ["/home/user/app/", "/home/user/report.json"];
// Over ustar's 255 characters, with one segment over its 100: a pax header.
const longName = `${"nested/".repeat(20)}${"x".repeat(120)}.txt`;
const files: GradingFileEntry[] = [
  { type: "directory", path: "home/user/app" },
  {
    type: "file",
    path: "home/user/app/run.sh",
    executable: true,
    data: bytes("#!/bin/sh\necho hi\n"),
  },
  {
    type: "file",
    path: `home/user/app/${longName}`,
    executable: false,
    data: bytes("deep"),
  },
  {
    type: "file",
    path: "home/user/report.json",
    executable: false,
    data: bytes('{"total": 3}'),
  },
];

/** A tar of raw entries, hostile ones included. */
function tarOf(entries: Array<HeaderData & { data?: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { data, ...header } of entries) {
    const block = Buffer.alloc(512);
    new Header({
      mode: 0o644,
      mtime: new Date(0),
      size: data?.byteLength ?? 0,
      ...header,
    }).encode(block);
    parts.push(block);
    if (data) {
      parts.push(data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
    }
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(Buffer.concat(parts));
}

describe("the grading archive", () => {
  it("keeps the exact iteration.json and every declared file, executable bit and long paths included", async () => {
    const archive = buildGradingArchive({ iterationJson, files })!;
    expect(archive.byteLength % 512).toBe(0);
    const read = await readGradingArchive(archive, declared);
    expect(read).toEqual({ ok: true, input: { iterationJson, files } });
  });

  it("drops what the run did not declare, a link and a path with ..", async () => {
    const archive = tarOf([
      { path: "iteration.json", type: "File", data: bytes(iterationJson) },
      { path: "files/home/user/report.json", type: "File", data: bytes("{}") },
      { path: "files/home/user/other.txt", type: "File", data: bytes("x") },
      {
        path: "files/home/user/app/link",
        type: "SymbolicLink",
        linkpath: "/etc/passwd",
      },
      {
        path: "files/home/user/app/../../../etc/x",
        type: "File",
        data: bytes("x"),
      },
    ]);
    const read = await readGradingArchive(archive, declared);
    expect(read).toEqual({
      ok: true,
      input: {
        iterationJson,
        files: [
          {
            type: "file",
            path: "home/user/report.json",
            executable: false,
            data: bytes("{}"),
          },
        ],
      },
    });
  });

  it("refuses a compressed, an empty or a malformed archive", async () => {
    const good = buildGradingArchive({ iterationJson, files })!;
    const unreadable = {
      ok: false,
      problem: "Couldn't read the stored grading files for this iteration.",
    };
    expect(await readGradingArchive(gzipSync(good), declared)).toEqual(
      unreadable,
    );
    expect(await readGradingArchive(new Uint8Array(1024), declared)).toEqual(
      unreadable,
    );
    const notJson = tarOf([
      { path: "iteration.json", type: "File", data: bytes("{not json") },
    ]);
    expect(await readGradingArchive(notJson, declared)).toEqual(unreadable);
    const twice = tarOf([
      { path: "iteration.json", type: "File", data: bytes(iterationJson) },
      { path: "iteration.json", type: "File", data: bytes("{}") },
    ]);
    expect(await readGradingArchive(twice, declared)).toEqual(unreadable);
    const corrupt = new Uint8Array(good);
    corrupt[148] = 0x41; // the first header's checksum
    expect(await readGradingArchive(corrupt, declared)).toEqual(unreadable);
  });

  it("refuses declared files over the run's own 25 MB cap", async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    const archive = buildGradingArchive({
      iterationJson,
      files: [
        {
          type: "file",
          path: "home/user/report.json",
          executable: false,
          data: big,
        },
      ],
    })!;
    expect(await readGradingArchive(archive, declared)).toMatchObject({
      ok: false,
    });
  });

  it("keeps no archive over 64 MB", () => {
    const big = new Uint8Array(MAX_GRADING_ARCHIVE_BYTES);
    expect(
      buildGradingArchive({
        iterationJson,
        files: [
          {
            type: "file",
            path: "home/user/report.json",
            executable: false,
            data: big,
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("reading a stored archive back", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const archive = buildGradingArchive({ iterationJson, files: [] })!;

  it("fetches it within its byte cap", async () => {
    const fetchMock = vi.fn(async () => new Response(archive));
    vi.stubGlobal("fetch", fetchMock);
    const fetched = await fetchGradingArchive({
      url: "https://storage.test/archive",
      bytes: archive.byteLength,
    });
    expect(fetched).toEqual({ ok: true, archive });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.test/archive",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("says why it couldn't, without fetching what it must not", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await fetchGradingArchive({
        url: "https://storage.test/archive",
        bytes: MAX_GRADING_ARCHIVE_BYTES + 1,
      }),
    ).toEqual({
      ok: false,
      problem:
        "Couldn't use the stored grading files for this iteration because they are over 64 MB.",
    });
    const failed = {
      ok: false,
      problem:
        "Couldn't load the stored grading files for this iteration. Try the test again.",
    };
    expect(
      await fetchGradingArchive({ url: "http://storage.test/a", bytes: 1 }),
    ).toEqual(failed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await fetchGradingArchive({ url: "https://storage.test/a", bytes: 1 }),
    ).toEqual(failed);
  });

  it("stops reading a body larger than it said", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array(MAX_GRADING_ARCHIVE_BYTES + 1)),
      ),
    );
    expect(
      await fetchGradingArchive({ url: "https://storage.test/a", bytes: 10 }),
    ).toMatchObject({ ok: false });
  });
});

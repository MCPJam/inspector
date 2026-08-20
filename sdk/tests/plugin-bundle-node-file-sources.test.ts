/**
 * What the OpenAI readiness reader is told about an ARCHIVE, as opposed to the
 * files inside it.
 *
 * Moved here with its implementation: the adapters left the inspector server
 * so the CLI's local package modes could reach them without depending on a web
 * server, and a test that stayed behind would be guarding a re-export shim
 * rather than the rules it is about.
 *
 * The distinction is the point. Every path rule the portal enforces is checked
 * against the names the archive's central directory recorded, BEFORE anything
 * normalizes them — because normalization repairs a backslash separator and a
 * doubled segment, which are two of the things the portal rejects. An adapter
 * that reported normalized names would hand the reader a package that looks
 * clean and gets rejected on upload.
 *
 * The other half is absence. Every field this adapter cannot establish must be
 * ABSENT rather than empty, because the reader turns absence into a recorded
 * gap and emptiness into "checked, none found".
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  DIRECTORY_ARCHIVE_OBSERVATIONS,
  collectZipArchiveObservations,
} from "../src/plugin-bundle/node-file-sources.js";

const encoder = new TextEncoder();

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, encoder.encode(content));
  }
  return zip.generateAsync({ type: "uint8array" });
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC32_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip built from raw bytes, because the cases that matter cannot be written
 * any other way.
 *
 * JSZip's WRITER normalizes on the way in — it collapses `//` and `./`, and its
 * name-keyed store cannot hold the same name twice. Those are exactly the
 * conditions the portal rejects, so a fixture built through JSZip can only
 * produce archives that are already clean. This writes the local headers, the
 * central directory and the EOCD directly, storing each entry uncompressed, so
 * a test can put any name it likes in the directory — including the same one
 * twice.
 *
 * `entries` is a LIST of pairs rather than a record, so duplicates survive.
 */
function rawZipOf(entries: [string, string][]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const body = encoder.encode(content);
    const sum = crc32(body);

    const header = new Uint8Array(30 + nameBytes.byteLength);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(8, 0, true); // stored
    headerView.setUint32(14, sum, true);
    headerView.setUint32(18, body.byteLength, true);
    headerView.setUint32(22, body.byteLength, true);
    headerView.setUint16(26, nameBytes.byteLength, true);
    header.set(nameBytes, 30);
    local.push(header, body);

    const entry = new Uint8Array(46 + nameBytes.byteLength);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(10, 0, true); // stored
    entryView.setUint32(16, sum, true);
    entryView.setUint32(20, body.byteLength, true);
    entryView.setUint32(24, body.byteLength, true);
    entryView.setUint16(28, nameBytes.byteLength, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += header.byteLength + body.byteLength;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...local, ...central, eocd];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

describe("collectZipArchiveObservations", () => {
  it("reports the uploaded byte length, which is what the size limit measures", async () => {
    const bytes = await zipOf({ "plugin.json": "{}" });
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.compressedBytes).toBe(bytes.byteLength);
  });

  it("reports a backslash separator as the archive spelled it", async () => {
    // A backslash separator is one of the things the portal rejects and
    // `normalizeBundlePath` repairs, so it is exactly the name that must reach
    // the reader untouched: normalize first and the package reads clean right
    // up until the upload bounces.
    //
    // Backslash rather than `a//b` or `./c` because JSZip's WRITER collapses
    // those two on the way in — a fixture cannot produce them through this
    // API, so asserting on them would test the fixture, not the adapter.
    const bytes = await zipOf({
      "plugin.json": "{}",
      "skills\\weather\\SKILL.md": "name: w",
    });
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.rawEntryNames).toContain("skills\\weather\\SKILL.md");
  });

  it("distinguishes an EMPTY archive from an unread one", async () => {
    // The boundary this whole module is about: `[]` is a measurement — the
    // archive was read and held nothing — and absence is a gap. An empty
    // archive is the case where those two are easiest to swap by accident.
    const observed = await collectZipArchiveObservations(await zipOf({}));
    expect(observed.rawEntryNames).toEqual([]);
    expect(observed.compressedBytes).toBeGreaterThan(0);
  });

  it("keeps BOTH records of a duplicated name, which the loader collapses", async () => {
    // The zip-confusion case, and the reason these names cannot come from the
    // loader. JSZip's `files` is name-keyed, so two central-directory records
    // for `dup.txt` arrive as one — last one wins. The reader would then grade
    // whichever copy the loader kept while an extractor taking the FIRST gets
    // different bytes, and the duplicate-path rule could never fire because
    // there was no longer a duplicate to see.
    const bytes = rawZipOf([
      ["plugin.json", "{}"],
      ["dup.txt", "first"],
      ["dup.txt", "second"],
    ]);
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.rawEntryNames).toEqual(["plugin.json", "dup.txt", "dup.txt"]);
  });

  it("reports traversal and empty segments as the directory spelled them", async () => {
    // The other half of what the loader repairs: `..` is resolved and `//` and
    // `./` are collapsed while it builds its tree. Each is a portal rejection,
    // and each would reach the reader already fixed.
    const bytes = rawZipOf([
      ["plugin.json", "{}"],
      ["../evil.txt", "x"],
      ["a//b.txt", "y"],
      ["./c.txt", "z"],
    ]);
    const observed = await collectZipArchiveObservations(bytes);
    expect(observed.rawEntryNames).toContain("../evil.txt");
    expect(observed.rawEntryNames).toContain("a//b.txt");
    expect(observed.rawEntryNames).toContain("./c.txt");
  });

  it("states every archive fact as absent for a directory source", () => {
    // An extracted tree has no compressed size, no encryption flags and no
    // pre-normalization names. Every field absent is the honest report, and
    // the reader turns each one into a named gap.
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.compressedBytes).toBeUndefined();
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.rawEntryNames).toBeUndefined();
    expect(DIRECTORY_ARCHIVE_OBSERVATIONS.encryptedEntryPaths).toBeUndefined();
  });

  it("leaves encryption flags ABSENT rather than empty", async () => {
    // JSZip cannot enumerate encrypted entries at all. Reporting `[]` would
    // assert "checked, none found" for a check that never ran.
    const observed = await collectZipArchiveObservations(
      await zipOf({ "plugin.json": "{}" }),
    );
    expect(observed.encryptedEntryPaths).toBeUndefined();
  });

  it("survives an archive it cannot read, keeping the one fact it still has", async () => {
    // The usual shape of this is a password-protected zip: JSZip rejects it
    // outright rather than listing entries. Letting that reject escape would
    // turn a gradeable submission into a crashed run — and an encrypted upload
    // is precisely a case the report exists to explain. The size survives
    // because it is measured on the bytes, not read out of the archive.
    const notAZip = encoder.encode("PK and then nothing valid");
    const observed = await collectZipArchiveObservations(notAZip);
    expect(observed.compressedBytes).toBe(notAZip.byteLength);
    // Everything the archive would have had to be read to learn stays absent,
    // so the reader records a gap instead of a pass.
    expect(observed.rawEntryNames).toBeUndefined();
    expect(observed.encryptedEntryPaths).toBeUndefined();
  });
});
